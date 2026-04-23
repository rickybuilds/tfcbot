// voicebot.js
"use strict";

const path = process.env.ENV_FILE || ".env";
require("dotenv").config({ path });
console.log(`[dotenv] loaded from ${path}`);

const fs = require("fs");
const net = require("net");
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
const { Readable } = require("stream");

const ROLE = (process.env.BOT_ROLE || "").toLowerCase();
if (!["blue", "red", "spectator"].includes(ROLE)) {
  console.error("BOT_ROLE must be 'blue', 'red' or 'spectator'");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

function tlog(...args) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.log(`[${ts}]`, ...args);
}

/* -------------------------------------------------------------------------- */
/* TEAM MIXER (Blue / Red bots)                                               */
/* -------------------------------------------------------------------------- */
class TeamVoiceMixer extends Readable {
  constructor() {
    super({ objectMode: false });
    this.streams = new Map();
    this.frameSize = 3840;
    this.needsData = false;
    this.interval = setInterval(() => this.flush(), 20);
    tlog(`Team mixer started (${ROLE})`);
  }

  _read() {
    this.needsData = true;
  }

  addStream(userId, opusStream) {
    if (this.streams.has(userId)) return;

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    this.streams.set(userId, { decoder, buffer: Buffer.alloc(0), opusStream });
    opusStream.pipe(decoder);

    decoder.on("data", (chunk) => {
      const s = this.streams.get(userId);
      if (s) s.buffer = Buffer.concat([s.buffer, chunk]);
    });

    tlog(`Added stream ${userId} (${this.streams.size} total)`);
  }

  removeStream(userId) {
    const s = this.streams.get(userId);
    if (!s) return;
    s.decoder.destroy();
    s.opusStream.destroy();
    this.streams.delete(userId);
    tlog(`Removed stream ${userId} (${this.streams.size} left)`);
  }

  flush() {
    if (!this.needsData) return;
    this.needsData = false;

    const chunks = [];
    this.streams.forEach((s) => {
      let chunk = s.buffer.slice(0, this.frameSize);
      if (chunk.length < this.frameSize)
        chunk = Buffer.concat([chunk, Buffer.alloc(this.frameSize - chunk.length, 0)]);
      chunks.push(chunk);
      s.buffer = s.buffer.slice(this.frameSize);
    });

    const mixed = Buffer.alloc(this.frameSize);
    for (let i = 0; i < this.frameSize; i += 4) {
      let lSum = 0, rSum = 0, speakers = 0;
      chunks.forEach((chunk) => {
        lSum += chunk.readInt16LE(i);
        rSum += chunk.readInt16LE(i + 2);
        speakers++;
      });
      let left  = speakers ? Math.round(lSum / speakers) : 0;
      let right = speakers ? Math.round(rSum / speakers) : 0;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      if (peak > 30000) {
        const scale = Math.pow(30000 / peak, 0.8);
        left *= scale;
        right *= scale;
      }
      mixed.writeInt16LE(Math.max(-32768, Math.min(32767, left)),  i);
      mixed.writeInt16LE(Math.max(-32768, Math.min(32767, right)), i + 2);
    }
    this.push(mixed);
  }

  destroy() {
    clearInterval(this.interval);
    this.streams.forEach((s) => s.decoder.destroy());
    this.push(null);
  }
}

/* -------------------------------------------------------------------------- */
/* MAIN BOT LOGIC                                                             */
/* -------------------------------------------------------------------------- */

let connection, teamMixer, player;

client.once("clientReady", async () => {
  tlog(`Logged in as ${client.user.tag} (${ROLE})`);

  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const channel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID);

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: ROLE !== "spectator",
  });

  /* --------------------------- BLUE / RED BOT LOGIC --------------------------- */
  if (ROLE === "blue" || ROLE === "red") {
    teamMixer = new TeamVoiceMixer();
    teamMixer.resume();

    const pipeFile = ROLE === "blue" ? "/tmp/blue.pcm" : "/tmp/red.pcm";

    tlog(`${ROLE.toUpperCase()} → writing PCM to ${pipeFile}`);

    const pipeStream = fs.createWriteStream(pipeFile);
    teamMixer.pipe(pipeStream);

    connection.on(VoiceConnectionStatus.Ready, async () => {
      tlog(`JOINED VOICE: ${channel.name}`);

      // Subscribe to everyone already in the channel
      channel.members.forEach((member) => {
        const uid = member.id;
        if (uid === client.user.id || teamMixer.streams.has(uid)) return;
        const sub = connection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
        teamMixer.addStream(uid, sub);
      });

      // Fallback: subscribe on speaking start in case we missed someone
      connection.receiver.speaking.on("start", (uid) => {
        if (uid === client.user.id || teamMixer.streams.has(uid)) return;
        const sub = connection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
        teamMixer.addStream(uid, sub);
      });

      // Handle joins and leaves
      client.on("voiceStateUpdate", (oldState, newState) => {
        const uid = newState.member?.id;
        if (!uid || uid === client.user.id) return;

        if (newState.channelId === channel.id && oldState.channelId !== channel.id) {
          if (!teamMixer.streams.has(uid)) {
            const sub = connection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
            teamMixer.addStream(uid, sub);
          }
        }

        if (oldState.channelId === channel.id && newState.channelId !== channel.id) {
          teamMixer.removeStream(uid);
        }
      });
    });
  }

  /* --------------------------- SPECTATOR BOT LOGIC --------------------------- */
  else if (ROLE === "spectator") {

    let ffmpegMixer = null;

  function startFfmpegMixer() {
    tlog("[Spectator] Starting ffmpeg mixer...");

    ffmpegMixer = spawn("ffmpeg", [
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "/tmp/blue.pcm",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "/tmp/red.pcm",
      "-filter_complex", "amix=inputs=2:duration=longest:dropout_transition=0,volume=2.0",
      "-f", "s16le", "-ar", "48000", "-ac", "2",
      "pipe:1"
    ]);

    ffmpegMixer.stderr.on("data", () => {});

    let bytesSinceLastLog = 0;

    ffmpegMixer.stdout.on("data", (chunk) => {
      bytesSinceLastLog += chunk.length;
    });

    const heartbeat = setInterval(() => {
      if (bytesSinceLastLog > 0) {
        tlog(`[Spectator] ✅ Relaying — ${(bytesSinceLastLog / 1024).toFixed(1)} KB in last 30s`);
      } else {
        tlog(`[Spectator] ⚠️ No audio data in last 30s — ffmpeg may be stalled`);
      }
      bytesSinceLastLog = 0;
    }, 30000);

    ffmpegMixer.on("close", (code) => {
      clearInterval(heartbeat);
      tlog(`[Spectator] ffmpeg mixer exited (${code}) — restarting in 1s`);
      setTimeout(startFfmpegMixer, 1000);
    });

    return ffmpegMixer;
  }

    /* Control Port */
    const CONTROL_PORT = Number(process.env.VOICE_CONTROL_PORT || 6200);
    const controlServer = net.createServer((sock) => {
      tlog("[Spectator] Control client connected");
      let buffer = "";
      sock.on("data", (data) => {
        buffer += data.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            tlog("[Spectator] Control message received:", msg.type);
          } catch (e) {
            console.error("[Spectator] Bad control message:", e);
          }
        }
      });
    });

    controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
      tlog(`[Spectator] Control port listening on 127.0.0.1:${CONTROL_PORT}`);
    });

    connection.on(VoiceConnectionStatus.Ready, async () => {
      tlog(`JOINED VOICE: ${channel.name}`);

      player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });

      connection.subscribe(player);

      const mixer = startFfmpegMixer();

      const resource = createAudioResource(mixer.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      resource.volume?.setVolume(2.0);
      player.play(resource);

      tlog("SPECTATOR READY — audio live");
      tlog("READY");
    });
  }

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    tlog("Voice disconnected — rejoining in 2s...");
    setTimeout(() => {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: ROLE !== "spectator",
      });
    }, 2000);
  });
});

client.login(process.env.DISCORD_TOKEN);