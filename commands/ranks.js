// commands/ranks.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { RANK_BANDS } = require("../lib/ranks");

function register(registry) {
  registry.set("ranks", async (message) => {
    const lines = RANK_BANDS.map(
      (b) =>
        `**Rank ${b.rank}${b.label ? ` (${b.label})` : ""}** → ${b.min} - ${b.max === Infinity ? "∞" : b.max} Elo`
    );

    const emb = new EmbedBuilder()
      .setColor(0x00ae86)
      .setTitle("📊 Elo Bands")
      .setDescription(lines.join("\n"))
      .setFooter({ text: "Use !elo to see your current rating and band" });

    await message.channel.send({ embeds: [emb] });
  });
}

module.exports = { register };
