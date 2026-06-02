// commands/spintest.js
"use strict";

const { EmbedBuilder } = require("discord.js");

const maps = ["bitchass", "spek"];

module.exports = {
  name: "spintest",
  description: "Map deathmatch tiebreaker",

  async execute(message) {
    const OWNER_ID = [
      "255834576742645761",
      "737481545216163891",
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
      "got rocket spammed",
      "ate a grenade",
      "got airshotted",
      "took a pipe to the face",
      "got EMP'd",
      "was conc-jumped into lava",
      "forgot to prime the grenade",
      "walked into SG fire",
      "got backstabbed",
      "missed the BHop",
      "telefragged themselves",
      "got caught in a MIRV",
      "got nailed to a wall",
      "pressed reload instead",
      "forgot armor exists",
      "got juggled by rockets",
      "was spawncamped",
      "got gibbed",
      "got caught with medkit out",
      "walked into a detpack",
      "was chasing pack timers",
      "got denied by a dispenser",
      "got sent to spectator",
      "forgot the enemy had quad",
      "fell off battlements",
      "got sniped crossing mid",
      "got vaporized",
      "hit every wall except the enemy",
      "disconnected mid-fight",
      "looked away for one second",
    ];

    const render = (eventText = "Match start") => {

      const lines = aliveMaps
        .filter((m) => m.hp > 0)
        .map((m) => {

          const hearts =
            "❤️".repeat(m.hp) +
            "🤍".repeat(maxHp - m.hp);

          return `• **${m.name.toUpperCase()}**  ${hearts}`;

        })
        .join("\n");

      return `${lines}\n\n> ${eventText}`;

    };

    const msg = await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("MAP TIEBREAKER DEATHMATCH")
          .setDescription(render("MATCH START")),
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
          attacks.splice(
            Math.floor(Math.random() * attacks.length),
            1
          )[0] || "got fragged";

        eventText = `${victim.name.toUpperCase()} ${attack}!`;
      }

      const livingCount = aliveMaps.filter((x) => x.hp > 0).length;

      let delay = 1600;

      if (livingCount <= 3) delay = 2000;
      if (livingCount <= 2) delay = 2600;

      await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Math.random() > 0.5 ? 0xed4245 : 0x5865f2)
            .setTitle("MAP TIEBREAKER DEATHMATCH")
            .setDescription(render(eventText)),
        ],
      });

      await new Promise((r) => setTimeout(r, delay));
    }

    const winner = aliveMaps.find((x) => x.hp > 0);

    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("TIEBREAKER COMPLETE")
          .setDescription(
            `After intense combat...\n\n**${winner.name.toUpperCase()}**\n\nsurvives the chaos.`
          ),
      ],
    });

    console.log(`[spintest] winner=${winner.name}`);
  },
};