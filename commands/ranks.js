// commands/ranks.js
"use strict";

const { EmbedBuilder } = require("discord.js");

function register(registry) {
  registry.set("ranks", async (message) => {
    // Elo bands (from low to high)
    const bands = [
      { rank: "1",  min: 300,  max: 720 },
      { rank: "2",  min: 721,  max: 1050 },
      { rank: "3",  min: 1051, max: 1390 },
      { rank: "4",  min: 1391, max: 1640 },
      { rank: "5",  min: 1641, max: 2000 },
      { rank: "6",  min: 2001, max: 2460 },
      { rank: "7",  min: 2461, max: 2730 },
      { rank: "8",  min: 2731, max: 3010 },
      { rank: "9",  min: 3011, max: 3200 },
      { rank: "10", min: 3201, max: 3599 },
      { rank: "S",  min: 3600, max: Infinity },
    ];

    const lines = bands.map(
      (b) =>
        `**Rank ${b.rank}** → ${b.min} - ${b.max === Infinity ? "∞" : b.max} Elo`
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
