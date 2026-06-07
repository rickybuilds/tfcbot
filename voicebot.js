"use strict";

const envPath = process.env.ENV_FILE || ".env";
require("dotenv").config({ path: envPath });
console.log(`[dotenv] loaded from ${envPath}`);

const net  = require("net");
const { spawn } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  EndBehaviorType,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { Readable, PassThrough } = require("stream");

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const ROLE = (process.env.BOT_ROLE || "").toLowerCase();
if (!["blue", "red", "spectator"].includes(ROLE)) {
  console.error("BOT_ROLE must be 'blue', 'red', or 'spectator'");
  process.exit(1);
}

const BLUE_PORT = Number(process.env.BLUE_PCM_PORT || 7001);
const RED_PORT  = Number(process.env.RED_PCM_PORT  || 7002);

function tlog(...args) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${ts}]`, ...args);
}

// Swallow unhandled errors globally so one bad socket never crashes the process
process.on("uncaughtException", (err) => {
  tlog(`[uncaughtException] ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  tlog(`[unhandledRejection] ${err}`);
});

/* -------------------------------------------------------------------------- */
/* TEAM MIXER                                                                 */
/* -------------------------------------------------------------------------- */
class TeamVoiceMixer extends Readable {
  constructor(role) {
    super({ objectMode: false, highWaterMark: 3840 * 20 });
    this.role      = role;
    this.streams   = new Map();
    this.frameSize = 3840;
    this._paused   = false;
    this._clock    = setInterval(() => this._flush(), 20);
    tlog(`[${role}] Mixer started`);
  }

  _read() {
    this._paused = false;
  }

  addStream(userId, opusStream) {
    if (this.streams.has(userId)) return;
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const entry   = { decoder, buffer: Buffer.alloc(0), opusStream };
    this.streams.set(userId, entry);
    opusStream.pipe(decoder);
    decoder.on("data", (chunk) => {
      const s = this.streams.get(userId);
      if (s) s.buffer = Buffer.concat([s.buffer, chunk]);
    });
    decoder.on("error", (e) => tlog(`[${this.role}] decoder error ${userId}: ${e.message}`));
    opusStream.on("error", (e) => tlog(`[${this.role}] opus error ${userId}: ${e.message}`));
    opusStream.on("close", () => this.removeStream(userId));
    tlog(`[${this.role}] +stream ${userId} (total=${this.streams.size})`);
  }

  removeStream(userId) {
    const s = this.streams.get(userId);
    if (!s) return;
    try { s.decoder.destroy(); }    catch {}
    try { s.opusStream.destroy(); } catch {}
    this.streams.delete(userId);
    tlog(`[${this.role}] -stream ${userId} (total=${this.streams.size})`);
  }

  _flush() {
    if (this._paused) return;
    const frame = Buffer.alloc(this.frameSize, 0);

    if (this.streams.size > 0) {
      for (let i = 0; i < this.frameSize; i += 4) {
        let lSum = 0, rSum = 0;
        this.streams.forEach((s) => {
          if (s.buffer.length >= i + 4) {
            lSum += s.buffer.readInt16LE(i);
            rSum += s.buffer.readInt16LE(i + 2);
          }
        });
        const peak = Math.max(Math.abs(lSum), Math.abs(rSum));
        if (peak > 32767) {
          const scale = 32767 / peak;
          lSum = Math.round(lSum * scale);
          rSum = Math.round(rSum * scale);
        }
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, lSum)), i);
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, rSum)), i + 2);
      }
      this.streams.forEach((s) => {
        s.buffer = s.buffer.length >= this.frameSize
          ? s.buffer.slice(this.frameSize)
          : Buffer.alloc(0);
      });
    }

    const ok = this.push(frame);
    if (!ok) this._paused = true;
  }

  destroy() {
    clearInterval(this._clock);
    this.streams.forEach((_, uid) => this.removeStream(uid));
    try { this.push(null); } catch {}
    super.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* DISCORD CLIENT                                                             */
/* -------------------------------------------------------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("clientReady", async () => {
  tlog(`Logged in as ${client.user.tag} (role=${ROLE})`);

  const guild   = await client.guilds.fetch(process.env.GUILD_ID);
  const channel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID);

  const connection = joinVoiceChannel({
    channelId:      channel.id,
    guildId:        guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf:       false,
    selfMute:       ROLE !== "spectator",
  });

  /* -----------------------------------------------------------------------
     BLUE / RED
     ----------------------------------------------------------------------- */
  if (ROLE === "blue" || ROLE === "red") {
    const TARGET_PORT = ROLE === "blue" ? BLUE_PORT : RED_PORT;
    const mixer       = new TeamVoiceMixer(ROLE);

    function connectToSpectator() {
      tlog(`[${ROLE}] Connecting to spectator on port ${TARGET_PORT}...`);
      const sock = net.connect(TARGET_PORT, "127.0.0.1");

      // Must attach error handler before connect fires to avoid unhandled error crash
      sock.on("error", (err) => {
        tlog(`[${ROLE}] Socket error: ${err.message} — retry in 2s`);
      });

      sock.on("connect", () => {
        tlog(`[${ROLE}] Connected to spectator — streaming PCM`);
        mixer.pipe(sock);
        mixer.resume();
      });

      sock.on("close", () => {
        tlog(`[${ROLE}] Socket closed — retry in 2s`);
        try { mixer.unpipe(sock); } catch {}
        setTimeout(connectToSpectator, 2000);
      });
    }

    connection.on(VoiceConnectionStatus.Ready, () => {
      tlog(`[${ROLE}] Joined voice: ${channel.name}`);

      channel.members.forEach((member) => {
        if (member.id === client.user.id) return;
        const sub = connection.receiver.subscribe(member.id, {
          end: { behavior: EndBehaviorType.Manual },
        });
        mixer.addStream(member.id, sub);
      });

      connection.receiver.speaking.on("start", (uid) => {
        if (uid === client.user.id || mixer.streams.has(uid)) return;
        const sub = connection.receiver.subscribe(uid, {
          end: { behavior: EndBehaviorType.Manual },
        });
        mixer.addStream(uid, sub);
      });

      client.on("voiceStateUpdate", (oldState, newState) => {
        const uid = newState.member?.id;
        if (!uid || uid === client.user.id) return;
        if (newState.channelId === channel.id && oldState.channelId !== channel.id) {
          if (!mixer.streams.has(uid)) {
            const sub = connection.receiver.subscribe(uid, {
              end: { behavior: EndBehaviorType.Manual },
            });
            mixer.addStream(uid, sub);
          }
        }
        if (oldState.channelId === channel.id && newState.channelId !== channel.id) {
          mixer.removeStream(uid);
        }
      });

      connectToSpectator();
    });
  }

  /* -----------------------------------------------------------------------
     SPECTATOR
     ----------------------------------------------------------------------- */
  else if (ROLE === "spectator") {

    const bluePass = new PassThrough({ highWaterMark: 3840 * 20 });
    const redPass  = new PassThrough({ highWaterMark: 3840 * 20 });

    // Swallow errors on the PassThroughs themselves so a reset never bubbles up
    bluePass.on("error", (e) => tlog(`[Spectator] bluePass error: ${e.message}`));
    redPass.on("error",  (e) => tlog(`[Spectator] redPass error: ${e.message}`));

    function makePcmServer(port, label, dest) {
      const server = net.createServer((sock) => {
        tlog(`[Spectator] ${label} bot connected`);
        sock.on("error", (e) => tlog(`[Spectator] ${label} socket error: ${e.message}`));
        sock.on("close", () => tlog(`[Spectator] ${label} bot disconnected`));
        sock.pipe(dest, { end: false });
      });
      server.on("error", (e) => tlog(`[Spectator] ${label} server error: ${e.message}`));
      server.listen(port, "127.0.0.1", () => {
        tlog(`[Spectator] Listening for ${label} PCM on port ${port}`);
      });
    }

    makePcmServer(BLUE_PORT, "blue", bluePass);
    makePcmServer(RED_PORT,  "red",  redPass);

    const CONTROL_PORT = Number(process.env.VOICE_CONTROL_PORT || 6200);
    net.createServer((sock) => {
      sock.on("error", (e) => tlog(`[Spectator] control socket error: ${e.message}`));
      tlog("[Spectator] Control client connected");
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            tlog("[Spectator] Control msg:", msg.type);
          } catch (e) {
            tlog("[Spectator] Bad control msg:", e.message);
          }
        }
      });
    }).listen(CONTROL_PORT, "127.0.0.1", () => {
      tlog(`[Spectator] Control port on 127.0.0.1:${CONTROL_PORT}`);
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      tlog(`[Spectator] Joined voice: ${channel.name}`);

      // Small highWaterMark — we want Discord to consume immediately, not buffer up
      const audioPass = new PassThrough({ highWaterMark: 3840 * 4 });
      audioPass.on("error", (e) => tlog(`[Spectator] audioPass error: ${e.message}`));

      // Drain the buffer if it grows beyond ~200ms worth of audio (38400 bytes).
      // This is what keeps the bot "live" — if Discord falls behind we drop old
      // audio instead of letting the delay snowball over time.
      const MAX_BUFFER = 3840 * 10; // ~200ms
      setInterval(() => {
        const buffered = audioPass.readableLength;
        if (buffered > MAX_BUFFER) {
          const drop = audioPass.read(buffered - MAX_BUFFER);
          if (drop) tlog(`[Spectator] ⏩ Dropped ${(drop.length / 1024).toFixed(1)} KB to stay live`);
        }
      }, 200);

      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      connection.subscribe(player);

      const resource = createAudioResource(audioPass, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
      resource.volume?.setVolume(1.0);
      player.play(resource);

      let ffmpegProc     = null;
      let bytesSinceLast = 0;
      let emptyWindows   = 0;

      function startFfmpeg() {
        // Clean up old process first
        if (ffmpegProc) {
          try { bluePass.unpipe(ffmpegProc.stdio[3]); } catch {}
          try { redPass.unpipe(ffmpegProc.stdio[4]);  } catch {}
          try { ffmpegProc.stdio[3].destroy(); }        catch {}
          try { ffmpegProc.stdio[4].destroy(); }        catch {}
          try { ffmpegProc.kill("SIGKILL"); }           catch {}
          ffmpegProc = null;
        }

        tlog("[Spectator] Starting ffmpeg mixer...");

        ffmpegProc = spawn("ffmpeg", [
          "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "512", "-i", "pipe:3",
          "-f", "s16le", "-ar", "48000", "-ac", "2", "-thread_queue_size", "512", "-i", "pipe:4",
          "-filter_complex",
          "amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,volume=.25",
          "-f", "s16le", "-ar", "48000", "-ac", "2",
          "pipe:1",
        ], {
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        });

        // Error handlers on ffmpeg's stdio pipes — missing these caused the ECONNRESET crash
        ffmpegProc.stdio[1].on("error", (e) => tlog(`[Spectator] ffmpeg stdout error: ${e.message}`));
        ffmpegProc.stdio[2].on("error", (e) => tlog(`[Spectator] ffmpeg stderr error: ${e.message}`));
        ffmpegProc.stdio[3].on("error", (e) => tlog(`[Spectator] ffmpeg pipe3 error: ${e.message}`));
        ffmpegProc.stdio[4].on("error", (e) => tlog(`[Spectator] ffmpeg pipe4 error: ${e.message}`));

        bluePass.pipe(ffmpegProc.stdio[3], { end: false });
        redPass.pipe(ffmpegProc.stdio[4],  { end: false });

        ffmpegProc.stderr.on("data", () => {});

        ffmpegProc.stdout.on("data", (chunk) => {
          bytesSinceLast += chunk.length;
          audioPass.write(chunk);
        });

        ffmpegProc.on("close", (code) => {
          tlog(`[Spectator] ffmpeg exited (${code}) — restarting in 500ms`);
          try { bluePass.unpipe(ffmpegProc.stdio[3]); } catch {}
          try { redPass.unpipe(ffmpegProc.stdio[4]);  } catch {}
          ffmpegProc = null;
          setTimeout(startFfmpeg, 500);
        });

        ffmpegProc.on("error", (err) => tlog(`[Spectator] ffmpeg error: ${err.message}`));
      }

      setInterval(() => {
        if (bytesSinceLast > 0) {
          tlog(`[Spectator] ✅ Relaying — ${(bytesSinceLast / 1024).toFixed(1)} KB in last 10s`);
          emptyWindows = 0;
        } else {
          emptyWindows++;
          tlog(`[Spectator] ⚠️  No audio (${emptyWindows}/3 empty windows)`);
          if (emptyWindows >= 3) {
            tlog("[Spectator] Pipeline stalled — restarting ffmpeg");
            emptyWindows = 0;
            startFfmpeg();
          }
        }
        bytesSinceLast = 0;
      }, 10000);

      startFfmpeg();
      tlog("[Spectator] READY — audio live");
    });
  }

  /* -----------------------------------------------------------------------
     RECONNECT
     ----------------------------------------------------------------------- */
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    tlog("Voice disconnected — rejoining in 2s...");
    setTimeout(() => joinVoiceChannel({
      channelId:      channel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       ROLE !== "spectator",
    }), 2000);
  });
});

client.login(process.env.DISCORD_TOKEN);