// services/voiceManager.js
"use strict";

const pm2 = require("pm2");

const BOT_SPECTATOR = "tfcbot-spectator";
const BOT_BLUE = "tfcbot-blue";
const BOT_RED = "tfcbot-red";

function connectPM2() {
  return new Promise((res, rej) => {
    pm2.connect((err) => (err ? rej(err) : res()));
  });
}

function startProcess(name) {
  return new Promise((resolve) => {
    pm2.start(name, (err) => {
      if (err) {
        console.error(`[VoiceManager] ❌ Failed to start ${name}:`, err.message);
      } else {
        console.log(`[VoiceManager] ✅ Started ${name}`);
      }
      resolve();
    });
  });
}

function stopProcess(name) {
  return new Promise((resolve) => {
    pm2.stop(name, (err) => {
      if (err) {
        console.error(`[VoiceManager] ⚠️ Failed to stop ${name}:`, err.message);
      } else {
        console.log(`[VoiceManager] 🛑 Stopped ${name}`);
      }
      resolve();
    });
  });
}

async function startVoiceBots() {
  await connectPM2();
  console.log("[VoiceManager] 🚀 Arming voice bots...");

  // Wait for spectator READY before starting blue/red
  const readyPromise = new Promise((resolve) => {
    pm2.launchBus((err, bus) => {
      if (err) {
        console.error("[VoiceManager] PM2 bus error:", err);
        return resolve();
      }

      let done = false;

      bus.on("log:out", (packet) => {
        if (packet.process.name !== BOT_SPECTATOR) return;

        const line = (packet.data || "").toString().trim();

        if (!done && (line.includes("SPECTATOR READY") || line.endsWith("READY"))) {
          done = true;
          console.log("[VoiceManager] 🎧 Spectator READY (matched:", line, ")");
          resolve();

          try { bus.close && bus.close(); } catch (_) {}
        }
      });

      // Safety fallback: max 15 seconds
      setTimeout(() => {
        if (!done) {
          console.log("[VoiceManager] ⚠️ Spectator READY timeout — starting blue/red anyway");
          resolve();
        }
      }, 15000);
    });
  });

  await startProcess(BOT_SPECTATOR);

  console.log("[VoiceManager] Waiting for spectator to say READY...");
  await readyPromise;

  // Start blue and red after the spectator is ready to accept their TCP streams.
  await Promise.all([startProcess(BOT_BLUE), startProcess(BOT_RED)]);

  pm2.disconnect();
  console.log("[VoiceManager] ✅ All voice bots online.");
}

async function stopVoiceBots() {
  await connectPM2();
  console.log("[VoiceManager] 🔻 Disarming voice bots...");

  // Stop blue/red first so they stop sending audio to the spectator.
  await stopProcess(BOT_BLUE);
  await stopProcess(BOT_RED);

  // No recording conversion is performed, so the spectator can stop immediately.
  await stopProcess(BOT_SPECTATOR);

  pm2.disconnect();
  console.log("[VoiceManager] 💤 All voice bots stopped.");
}

module.exports = { startVoiceBots, stopVoiceBots };
