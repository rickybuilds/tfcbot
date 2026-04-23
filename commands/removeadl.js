// commands/removeadl.js
"use strict";

const { refreshBotName } = require("../lib/botName");
const { postQueueBoard } = require("./queue");
const adl = require("../lib/adl");

module.exports = {
  name: "removeadl",
  aliases: ["--adl"],
  description: "Remove your ADL vote.",
  usage: "!removeadl  or  --adl",

  async run(message, { state, config }) {
    if (String(message.channel?.id) !== String(config.channels.pickup || "")) return;

    const id = String(message.author.id);

    // remove vote (idempotent)
    adl.unvote(id);
    try { global.persistQueueSoon?.(); } catch {}

    // 👇 also clear ADL marker on their queue entry
    const entry = (state.queue || []).find(p => String(p.id) === id);
    if (entry) entry.adlVote = false;

    // progress line
    const max = state.MAX_PLAYERS || Number(process.env.ADL_REQUIRED_PLAYERS || 8);
    const frozenIds = (state.queue || []).slice(0, max).map(p => p.id);
    const { useAdl, votes, required } = adl.shouldUseAdl(frozenIds, process.env);
    const remaining = Math.max(0, required - votes);

    await postQueueBoard(message.channel, state, null, null).catch(() => {});
    try { await refreshBotName(message.client, state); } catch {}

    if (useAdl) {
      await message.channel.send(`✅ **ADL still armed**. (${votes}/${required})`);
    } else {
      await message.channel.send(`ADL votes **${votes}/${required}** — need **${remaining}** more.`);
    }
  },
};
