// commands/spintest.js
"use strict";

const { EmbedBuilder } = require("discord.js");

const maps = ["openfire_lowgrens", "New Maps"];

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

    console.log("[spintest] Starting weighted map deathmatch");

    const maxHp = 3;

    const weightedMaps = maps.flatMap((m) =>
      /new\s*maps?/i.test(m) ? [m, m] : [m]
    );

    const oddsLines = maps.map((m) => {
      const tickets = weightedMaps.filter((x) => x === m).length;
      const pct = ((tickets / weightedMaps.length) * 100).toFixed(1);
      return `• **${m.toUpperCase()}** — ${tickets}/${weightedMaps.length} tickets (${pct}%)`;
    });

    const aliveMaps = weightedMaps.map((m, i) => ({
      name: m,
      hp: maxHp,
      ticket: i + 1,
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

    const displayName = (m) =>
      m.name.toUpperCase() + (m.name === "New Maps" ? ` #${m.ticket}` : "");

    const render = (eventText = "Match start") => {
      const lines = aliveMaps
        .filter((m) => m.hp > 0)
        .map((m) => {
          const hearts = "❤️".repeat(m.hp) + "🤍".repeat(maxHp - m.hp);
          return `• **${displayName(m)}**  ${hearts}`;
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
      content: `🎲 **Weighted odds**\n${oddsLines.join("\n")}`,
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
        eventText = `${displayName(victim)} was fragged!`;
      } else {
        const attack =
          attacks.splice(Math.floor(Math.random() * attacks.length), 1)[0] ||
          "got fragged";

        eventText = `${displayName(victim)} ${attack}!`;
      }

      const livingCount = aliveMaps.filter((x) => x.hp > 0).length;

      let delay = 1600;
      if (livingCount <= 3) delay = 2000;
      if (livingCount <= 2) delay = 2600;

      await msg.edit({
        content: `🎲 **Weighted odds**\n${oddsLines.join("\n")}`,
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
      content: `🎲 **Weighted odds**\n${oddsLines.join("\n")}`,
      embeds: [
        buildEmbed(
          "TIEBREAKER COMPLETE",
          `After intense combat...\n\n**${displayName(winner)}**\n\nsurvives the chaos.`,
          0x57f287
        ),
      ],
    });

    console.log(`[spintest] winner=${winner.name} ticket=${winner.ticket}`);
  },
};