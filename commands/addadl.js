// commands/addadl.js
"use strict";

const { addPlayerToQueue, maybeStartAutoFullVote } = require("./queue");
const adl = require("../lib/adl");

module.exports = {
  name: "addadl",
  aliases: ["++adl", "!addadl", "**"],

  description: "Join the queue and cast an ADL vote (all-in-one).",
  usage: "!addadl  or  ++adl",

  async run(message, deps) {
    const { state, config } = deps;
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;

    const id = String(message.author.id);

    // 🚫 Prevent locked players from joining
    if (state.lockedPlayers && state.lockedPlayers.has(id)) {
      const matchId = state.lockedPlayers.get(id);
      console.log(`[playerLock] ${id} tried to addadl but is locked in match ${matchId}`);
      try {
        await message.reply(
          `🚫 You’re currently locked in **Match ${matchId}**. Wait until it finishes before re-adding.`
        );
      } catch {}
      return;
    }

    // Existing queued players may still cast an ADL vote when the queue is full.
    let entry = state.queue.find(p => p.id === message.author.id);
    if (!entry && state.queue.length >= (state.MAX_PLAYERS || 8)) {
      return;
    }

    // Find or create player entry manually first
    if (!entry) {
      entry = {
        id: message.author.id,
        name: message.member?.displayName || message.author.username,
        lastSeenAt: Date.now(),
      };
      state.queue.push(entry);
    } else {
      entry.lastSeenAt = Date.now();
    }

    // Mark ADL vote before rendering
    entry.adlVote = true;
    adl.vote(String(entry.id));

    try { global.persistQueueSoon?.(); } catch {}

    // Now reuse normal add logic (which posts queue)
    await addPlayerToQueue(message, deps);

    // Progress update
    const max = state.MAX_PLAYERS || Number(process.env.ADL_REQUIRED_PLAYERS || 8);
    const frozenIds = (state.queue || []).slice(0, max).map(p => p.id);
    const { useAdl, votes, required } = adl.shouldUseAdl(frozenIds, process.env);
    const remaining = Math.max(0, required - votes);

    if (useAdl) {
      await message.channel.send(`✅ **ADL armed** for the next full match. (${votes}/${required})`);
    } else {
      await message.channel.send(
        `ADL Mode almost activated! **${remaining}** more ADL vote(s). (${votes}/${required})`
      );
    }

    await maybeStartAutoFullVote(message, state);
  },
};
