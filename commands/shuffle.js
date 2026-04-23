"use strict";

const Database = require("better-sqlite3");
const { generateFairScenarios } = require("../lib/odds");
const { EmbedBuilder } = require("discord.js");

module.exports = {
  name: "shuffle",
  description: "Admin-only: Randomly reshuffle teams for a match. Repeats pick new unused scenarios.",
  usage: "!shuffle <matchId>",

  async execute(message, args, ctx) {
    const { config, elo } = ctx;

    // --- Admin-only check ---
    const adminRoleId = config.roles.admin;
    const hasAdmin = message.member?.roles?.cache?.has(adminRoleId);
    if (!hasAdmin) return message.reply("🚫 You don’t have permission to use this command.");

    // --- Parse arguments ---
    const matchId = args[0];
    if (!matchId) return message.reply("Usage: `!shuffle <matchId>`");

    console.log(`[ADMIN] ${message.author.tag} used !shuffle ${matchId}`);

    // --- Load match ---
    const db = new Database("/root/tfcbot/elo.db");
    const match = db.prepare("SELECT * FROM matches WHERE match_id = ?").get(matchId);
    if (!match) {
      db.close();
      return message.reply(`❌ No match found for ID \`${matchId}\`.`);
    }

    // ✅ Only allow shuffling in-progress matches
    const status = String(match.status || "").toLowerCase();
    if (status !== "in_progress") {
      db.close();
      return message.reply(
        `🚫 You can only shuffle matches that are currently **in progress**.\n` +
        `This match is marked as **${match.status || "unknown"}**.`
      );
    }

    // --- Validate player counts ---
    const blue = JSON.parse(match.blue_ids || "[]");
    const red = JSON.parse(match.red_ids || "[]");
    const allPlayers = [...blue, ...red];
    if (allPlayers.length !== 8) {
      db.close();
      return message.reply("⚠️ This command only works for full 8-player matches.");
    }

    // --- Load or init shuffle history ---
    let usedScenarios = [];
    try {
      usedScenarios = JSON.parse(match.shuffle_history || "[]");
      if (!Array.isArray(usedScenarios)) usedScenarios = [];
    } catch {
      usedScenarios = [];
    }

    // --- Generate fair scenarios ---
    const scenarios = generateFairScenarios(allPlayers, elo);
    if (!scenarios?.length) {
      db.close();
      return message.reply("❌ Failed to generate scenarios for this match.");
    }

    // --- Pick a random unused scenario ---
    const unused = scenarios.filter((_, i) => !usedScenarios.includes(i));
    if (unused.length === 0) {
      // reset history if all used
      usedScenarios = [];
      unused.push(...scenarios);
    }

    const randomScenario = unused[Math.floor(Math.random() * unused.length)];
    const randomIdx = scenarios.indexOf(randomScenario);
    usedScenarios.push(randomIdx);

    const chosen = scenarios[randomIdx];
    if (!chosen) {
      db.close();
      return message.reply("❌ Failed to pick a valid scenario.");
    }

    // --- Update DB ---
    db.prepare(`
      UPDATE matches
      SET blue_ids = ?, red_ids = ?, shuffle_history = ?
      WHERE match_id = ?
    `).run(
      JSON.stringify(chosen.blue),
      JSON.stringify(chosen.red),
      JSON.stringify(usedScenarios),
      matchId
    );

    // --- Build embed ---
    const embed = new EmbedBuilder()
      .setColor(0x0088ff)
      .setTitle("🔁 Random Shuffle Applied")
      .setDescription(`Match **${matchId}** — Scenario #${randomIdx + 1}`)
      .addFields(
        { name: "🔵 Blue Team", value: chosen.blue.map(p => `<@${p}>`).join("\n") || "_none_", inline: true },
        { name: "🔴 Red Team", value: chosen.red.map(p => `<@${p}>`).join("\n") || "_none_", inline: true }
      )
      .setFooter({
        text: `Admin: ${message.author.tag} | Used ${usedScenarios.length}/${scenarios.length}`
      })
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
    db.close();
  },
};
