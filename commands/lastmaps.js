// commands/lastmaps.js
"use strict";

const { recentMapExclusions } = require("../lib/maps");

module.exports = {
  name: "lastmaps",
  description: "Show the last 7 maps excluded from voting (admin channel only).",
  usage: "!lastmaps",

  async run(message, { matchesStore, config }) {
    const ADMIN_CHANNEL = String(config.channels.maps);
    if (String(message.channel?.id) !== ADMIN_CHANNEL) return;

    try {
      const excluded = recentMapExclusions(matchesStore, 7);

      if (!excluded || excluded.size === 0) {
        return message.channel.send("⚠️ No recent maps found for exclusion.");
      }

      const lines = [...excluded].map((map, i) => `#${i + 1} → **${map}**`);

      return message.channel.send(
        `🗺️ Maps currently excluded from voting (last ${excluded.size}):\n${lines.join("\n")}`
      );
    } catch (e) {
      console.error("[lastmaps] failed:", e);
      return message.channel.send("⚠️ Error fetching last maps.");
    }
  },
};
