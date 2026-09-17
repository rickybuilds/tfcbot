"use strict";

const pm2 = require("pm2");
const BOT_SPECTATOR = "tfcbot-spectator";
const BOT_BLUE = "tfcbot-blue";
const BOT_RED = "tfcbot-red";

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    pm2[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

// Serialize match lifecycle requests so a late start cannot undo a stop.
let pending = Promise.resolve();
function serialized(action) {
  const result = pending.then(action);
  pending = result.catch(() => {});
  return result;
}

function startVoiceBots() {
  return serialized(async () => {
    await call("connect");
    try {
      // Team senders reconnect until the spectator is listening. No log-bus
      // subscription or leaked readiness timeout is needed for ordering.
      await call("start", BOT_SPECTATOR);
      const results = await Promise.allSettled([
        call("start", BOT_BLUE), call("start", BOT_RED),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      console.log("[VoiceManager] Voice processes started; see spectator READY for audio readiness.");
    } catch (error) {
      // Do not leave a partial match relay running after a failed start.
      await Promise.allSettled([BOT_BLUE, BOT_RED, BOT_SPECTATOR].map(name => call("stop", name)));
      throw error;
    } finally {
      pm2.disconnect();
    }
  });
}

function stopVoiceBots() {
  return serialized(async () => {
    await call("connect");
    try {
      const teams = await Promise.allSettled([call("stop", BOT_BLUE), call("stop", BOT_RED)]);
      const spectator = await Promise.allSettled([call("stop", BOT_SPECTATOR)]);
      const errors = [...teams, ...spectator].filter(result => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Could not stop all voice bots");
      console.log("[VoiceManager] All voice bots stopped.");
    } finally {
      pm2.disconnect();
    }
  });
}

module.exports = { startVoiceBots, stopVoiceBots };
