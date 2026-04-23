"use strict";

const { postQueueBoard } = require("./queue");
const COOLDOWN_MS = 90_000; // 90 seconds

// Independent cooldown trackers
let lastNoticeUse = 0;
let lastAdminUse  = 0;

async function run(message, args, { state, elo, privacy, config }) {
  const PICKUP_CHANNEL = String(config.channels.pickup || "");
  const NOTICE_ROLE    = String(config.roles.notice || "");
  const ADMIN_ROLE     = String(config.roles.admin || "");

  // Only respond in the pickup channel
  if (String(message.channel?.id) !== PICKUP_CHANNEL) return;

  const now = Date.now();
  const cmd = message.content.trim().toLowerCase();

  if (cmd === "!notice") {
    if (now - lastNoticeUse < COOLDOWN_MS) return; // still on cooldown

    // 🚨 Only fire if queue > 4
    if (!Array.isArray(state.queue) || state.queue.length < 5) return;

    lastNoticeUse = now;

    // 🧠 Bring up the queue board like !status
    await postQueueBoard(message.channel, state, elo, privacy);

    // 🔔 Then ping the notice role
    return message.channel.send(`<@&${NOTICE_ROLE}>`);
  }

  if (cmd === "!admin") {
    if (now - lastAdminUse < COOLDOWN_MS) return; // still on cooldown
    lastAdminUse = now;
    return message.channel.send(`<@&${ADMIN_ROLE}>`);
  }
}

function register(registry, deps) {
  registry.set("notice", (m, a) => run(m, a, deps));
  registry.set("admin",  (m, a) => run(m, a, deps));
}

module.exports = { register };
