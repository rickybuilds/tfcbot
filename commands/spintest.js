// commands/spintest.js
"use strict";

const { EmbedBuilder } = require("discord.js");

const maps = ["spek", "spek", "spek", "spek", "spek"];

module.exports = {
  name: "spintest",
  description: "Map deathmatch tiebreaker",

  async execute(message) {
    const OWNER_ID = [
      "255834576742645761",
      "737481545216163891",
	  "596225454721990676",
      "468578577537826831",
    ];

    if (!OWNER_ID.includes(message.author.id)) {
      try {
        if (message.deletable) await message.delete().catch(() => {});
      } catch {}
      return;
    }

    console.log("[spintest] Starting map deathmatch");

    const maxHp = 3;

    const aliveMaps = maps.map((m) => ({
      name: m,
      hp: maxHp,
    }));

 const attacks = [
  "won before the battle began",
  "attacked where the enemy was unprepared",
  "appeared where they were not expected",
  "turned weakness into bait",
  "used deception as a weapon",
  "struck only when victory was certain",
  "made the enemy defeat themselves",
  "chose the battlefield wisely",
  "moved like the wind",
  "stood firm like the mountain",
  "struck like fire",
  "waited in silence, then attacked",
  "avoided strength and hit weakness",
  "made chaos look like strategy",
  "used patience as a weapon",
  "won without unnecessary fighting",
  "forced the enemy into confusion",
  "hid strength behind weakness",
  "turned delay into advantage",
  "made retreat impossible",
  "attacked the enemy's plan",
  "controlled the pace of battle",
  "made the enemy chase shadows",
  "used discipline to survive",
  "struck at the perfect moment",
  "made victory inevitable",
  "left no opening unused",
  "turned terrain into a weapon",
  "broke morale before armor",
  "made the enemy fight blind",
];

    const render = (eventText = "Match start") => {
      const lines = aliveMaps
        .filter((m) => m.hp > 0)
        .map((m) => {
          const hearts = "❤️".repeat(m.hp) + "🤍".repeat(maxHp - m.hp);
          return `• **${m.name.toUpperCase()}**  ${hearts}`;
        })
        .join("\n");

      return `${lines}\n\n> ${eventText}`;
    };

    const buildEmbed = (title, desc, color) =>
      new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(desc);

    const msg = await message.channel.send({
      embeds: [
        buildEmbed(
          "MAP TIEBREAKER DEATHMATCH",
          render("MATCH START"),
          0x5865f2
        ),
      ],
    });

    await new Promise((r) => setTimeout(r, 1600));

    while (aliveMaps.filter((x) => x.hp > 0).length > 1) {
      const living = aliveMaps.filter((x) => x.hp > 0);
      const victim = living[Math.floor(Math.random() * living.length)];

      victim.hp--;

      let eventText;

      if (victim.hp <= 0) {
        eventText = `${victim.name.toUpperCase()} was fragged!`;
      } else {
        const attack =
          attacks.splice(Math.floor(Math.random() * attacks.length), 1)[0] ||
          "got fragged";

        eventText = `${victim.name.toUpperCase()} ${attack}!`;
      }

      const livingCount = aliveMaps.filter((x) => x.hp > 0).length;

      let delay = 1600;
      if (livingCount <= 3) delay = 2000;
      if (livingCount <= 2) delay = 2600;

      await msg.edit({
        embeds: [
          buildEmbed(
            "MAP TIEBREAKER DEATHMATCH",
            render(eventText),
            Math.random() > 0.5 ? 0xed4245 : 0x5865f2
          ),
        ],
      });

      await new Promise((r) => setTimeout(r, delay));
    }

    const winner = aliveMaps.find((x) => x.hp > 0);

    await msg.edit({
      embeds: [
        buildEmbed(
          "TIEBREAKER COMPLETE",
          `After intense combat...\n\n**${winner.name.toUpperCase()}**\n\nsurvives the chaos.`,
          0x57f287
        ),
      ],
    });

    console.log(`[spintest] winner=${winner.name}`);
  },
};