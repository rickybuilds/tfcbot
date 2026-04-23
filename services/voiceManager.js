// services/voiceManager.js
"use strict";

const pm2 = require("pm2");
const { execSync } = require("child_process");

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

/* -------------------------------------------------------------------------- */
/* Graceful shutdown of spectator when ffmpeg conversion is running           */
/* -------------------------------------------------------------------------- */

async function waitForSpectatorToFinish() {
  return new Promise((resolve) => {
    pm2.list((err, list) => {
      if (err) return resolve();

      const spec = list.find((p) => p.name === BOT_SPECTATOR);
      if (!spec) return resolve();

      pm2.launchBus((err, bus) => {
        if (err) return resolve();

        let done = false;

        bus.on("log:out", (packet) => {
          if (packet.process.name !== BOT_SPECTATOR) return;

          if (packet.data.includes("Safe to shutdown now")) {
            if (!done) {
              done = true;
              setTimeout(resolve, 500);
            }
          }
        });

        // Safety fallback: max 10 seconds wait
        setTimeout(() => {
          if (!done) resolve();
        }, 10000);
      });
    });
  });
}

/* -------------------------------------------------------------------------- */

async function startVoiceBots() {
  await connectPM2();
  console.log("[VoiceManager] 🚀 Arming voice bots...");

  // Create named pipes fresh — spectator ffmpeg and blue/red bots all need these
  try { execSync("rm -f /tmp/blue.pcm /tmp/red.pcm"); } catch {}
  execSync("mkfifo /tmp/blue.pcm && mkfifo /tmp/red.pcm");
  console.log("[VoiceManager] ✅ Named pipes created (/tmp/blue.pcm, /tmp/red.pcm)");

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

  // Start blue and red — they will open the named pipes for writing
  // spectator's ffmpeg is already waiting to read from them
  await Promise.all([startProcess(BOT_BLUE), startProcess(BOT_RED)]);

  pm2.disconnect();
  console.log("[VoiceManager] ✅ All voice bots online.");
}

async function stopVoiceBots() {
  await connectPM2();
  console.log("[VoiceManager] 🔻 Disarming voice bots...");

  // Stop blue/red first so they stop writing to the pipes
  await stopProcess(BOT_BLUE);
  await stopProcess(BOT_RED);

  // Clean up named pipes
  try { execSync("rm -f /tmp/blue.pcm /tmp/red.pcm"); } catch {}
  console.log("[VoiceManager] 🗑️ Named pipes removed");

  // Wait for spectator's ffmpeg recording conversion to finish
  await waitForSpectatorToFinish();

  // Now safe to stop spectator
  await stopProcess(BOT_SPECTATOR);

  pm2.disconnect();
  console.log("[VoiceManager] 💤 All voice bots stopped.");
}

module.exports = { startVoiceBots, stopVoiceBots };