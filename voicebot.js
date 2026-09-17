"use strict";

require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const net = require("node:net");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel, entersState, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, AudioPlayerStatus,
  NoSubscriberBehavior, StreamType, EndBehaviorType,
} = require("@discordjs/voice");
const prism = require("prism-media");
const { LiveMixer, DEFAULT_JITTER_FRAMES } = require("./lib/voicePcm");

function numberSetting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

async function main() {
  const role = (process.env.BOT_ROLE || "").toLowerCase();
  if (!["blue", "red", "spectator"].includes(role)) throw new Error("Invalid BOT_ROLE");
  for (const name of ["DISCORD_TOKEN", "GUILD_ID", "VOICE_CHANNEL_ID"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const bluePort = numberSetting("BLUE_PCM_PORT", 7001, 1, 65535);
  const redPort = numberSetting("RED_PCM_PORT", 7002, 1, 65535);
  if (!Number.isInteger(bluePort) || !Number.isInteger(redPort) || bluePort === redPort) {
    throw new Error("PCM ports must be distinct integers");
  }
  const gain = numberSetting("SPECTATOR_GAIN", 0.25, 0, 2);
  const jitterFrames = numberSetting("VOICE_JITTER_FRAMES", DEFAULT_JITTER_FRAMES, 1, 8);
  if (!Number.isInteger(jitterFrames)) throw new Error("VOICE_JITTER_FRAMES must be an integer");
  const log = (...args) => console.log(new Date().toISOString(), `[${role}]`, ...args);
  const client = new Client({ intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers,
  ] });
  const cleanup = [];
  let stopped = false;
  let connection;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const dispose of cleanup.reverse()) {
      try { dispose(); } catch (error) { log("Cleanup:", error.message); }
    }
    connection?.destroy();
    client.destroy();
  };
  const fail = error => {
    console.error(`[${role}] Fatal:`, error.message);
    process.exitCode = 1;
    stop(); // Let PM2 restart cleanly instead of swallowing a broken pipeline.
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  client.on("error", fail);

  client.once("clientReady", () => {
    void (async () => {
      const guild = await client.guilds.fetch(process.env.GUILD_ID);
      const channel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID);
      if (stopped) return;
      if (!channel?.isVoiceBased()) throw new Error("VOICE_CHANNEL_ID must identify a voice channel");
      connection = joinVoiceChannel({
        channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: role === "spectator", selfMute: role !== "spectator",
      });
      connection.on("error", fail);
      let recovering = false;
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (recovering || stopped) return;
        recovering = true;
        void (async () => {
          try {
            try { await entersState(connection, VoiceConnectionStatus.Ready, 5000); }
            catch {
              if (stopped) return;
              connection.rejoin();
              await entersState(connection, VoiceConnectionStatus.Ready, 15000);
            }
          } catch (error) { if (!stopped) fail(error); }
          finally { recovering = false; }
        })();
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 30000);
      if (stopped) return;
      const mixer = new LiveMixer({ gain: role === "spectator" ? gain : 1, prebufferFrames: jitterFrames });
      cleanup.push(() => mixer.destroy());
      mixer.on("error", fail);

      if (role !== "spectator") {
        const streams = new Map();
        const remove = uid => {
          const entry = streams.get(uid);
          if (!entry) return;
          streams.delete(uid);
          mixer.inputs.delete(uid);
          entry.opus.unpipe(entry.decoder);
          entry.opus.destroy();
          entry.decoder.destroy();
        };
        const subscribe = uid => {
          const member = channel.members.get(uid);
          if (stopped || !member || member.user.bot || streams.has(uid)) return;
          const opus = connection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.Manual } });
          const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
          const input = mixer.add(uid);
          streams.set(uid, { opus, decoder });
          const removeCurrent = () => { if (streams.get(uid)?.opus === opus) remove(uid); };
          for (const stream of [opus, decoder]) {
            stream.on("error", error => { log("Receive stream:", error.message); removeCurrent(); });
            stream.once("close", removeCurrent);
          }
          decoder.on("data", chunk => input.write(chunk));
          opus.pipe(decoder);
        };
        connection.receiver.speaking.on("start", subscribe);
        const onVoiceState = (before, after) => {
          if (before.guild.id !== guild.id) return;
          if (after.channelId !== channel.id) remove(after.id);
          else subscribe(after.id);
        };
        client.on("voiceStateUpdate", onVoiceState);
        cleanup.push(() => {
          connection.receiver.speaking.off("start", subscribe);
          client.off("voiceStateUpdate", onVoiceState);
          for (const uid of [...streams.keys()]) remove(uid);
        });
        channel.members.forEach(member => subscribe(member.id));

        let socket;
        let retry;
        // Drain continuously; a blocked local socket must not accumulate stale comms.
        mixer.on("data", frame => {
          if (socket?.readyState === "open" && !socket.write(frame)) socket.destroy();
        });
        const connect = () => {
          if (stopped) return;
          const current = net.connect(role === "blue" ? bluePort : redPort, "127.0.0.1");
          socket = current;
          current.setNoDelay(true);
          current.on("connect", () => log("Sending team audio to spectator"));
          current.on("error", error => log("Relay:", error.message));
          current.on("close", () => {
            if (socket === current) socket = null;
            if (!stopped) retry = setTimeout(connect, 2000);
          });
        };
        cleanup.push(() => { clearTimeout(retry); socket?.destroy(); });
        connect();
      } else {
        const listen = (port, label) => new Promise((resolve, reject) => {
          let active;
          const server = net.createServer(socket => {
            if (stopped) { socket.destroy(); return; }
            active?.destroy();
            active = socket;
            socket.setNoDelay(true);
            const input = mixer.add(label);
            socket.on("data", chunk => input.write(chunk));
            socket.on("error", error => log(`${label} relay:`, error.message));
            socket.on("close", () => {
              if (active !== socket) return;
              active = null;
              mixer.inputs.delete(label);
              log(`${label} disconnected; other team continues`);
            });
            log(`${label} connected`);
          });
          cleanup.push(() => { active?.destroy(); server.close(); });
          server.once("error", reject);
          server.on("error", fail);
          server.listen(port, "127.0.0.1", resolve);
        });
        await Promise.all([listen(bluePort, "blue"), listen(redPort, "red")]);
        if (stopped) return;
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        player.on("error", fail);
        player.on(AudioPlayerStatus.Idle, () => {
          if (!stopped) fail(new Error("Spectator audio stream ended unexpectedly"));
        });
        cleanup.push(() => player.stop(true));
        connection.subscribe(player);
        player.play(createAudioResource(mixer, { inputType: StreamType.Raw }));
        log("SPECTATOR READY - audio live");
      }
      const loopDelay = monitorEventLoopDelay({ resolution: 20 });
      loopDelay.enable();
      cleanup.push(() => loopDelay.disable());
      log(`Audio pipeline v3: jitterFrames=${jitterFrames} (20 ms each), bounded clock catch-up`);
      const health = setInterval(() => {
        const inputs = [...mixer.inputs.values()];
        const sum = key => inputs.reduce((n, input) => n + input[key], 0);
        log(`Health: inputs=${inputs.length} queuedBytes=${inputs.reduce((n, input) => n + input.buffer.length, 0)} droppedBytes=${sum("droppedBytes")} underflows=${sum("underflows")} receivedBytes=${sum("writtenBytes")} consumedBytes=${sum("consumedBytes")} backpressureTicks=${mixer.backpressureTicks} lateTicks=${mixer.lateTicks} clockSkippedFrames=${mixer.clockSkippedFrames} outputFrames=${mixer.outputFrames} loopMaxMs=${(loopDelay.max / 1e6).toFixed(1)} voice=${connection.state.status}`);
        loopDelay.reset();
      }, 60000);
      cleanup.push(() => clearInterval(health));
      log(`Joined ${channel.name}`);
    })().catch(fail);
  });
  try { await client.login(process.env.DISCORD_TOKEN); }
  catch (error) { fail(error); }
}

if (require.main === module) main().catch(error => {
  console.error("Voice bot startup failed:", error.message);
  process.exitCode = 1;
});

module.exports = { main };
