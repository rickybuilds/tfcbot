"use strict";

const { EmbedBuilder } = require("discord.js");
const {
  buildMatchScenarios,
  buildTeamObjects,
  summarizeSplit,
  getRating,
} = require("../lib/odds");

function parseIds(value) {
  try {
    const ids = JSON.parse(value || "[]");
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function snapshotFromScenarios(scenarios, selected = 1) {
  return {
    version: 1,
    selected,
    scenarios: scenarios.map(s => ({
      blue: s.blue.map(p => String(p.id ?? p)),
      red: s.red.map(p => String(p.id ?? p)),
    })),
  };
}

function loadSnapshot(raw) {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || !Array.isArray(value.scenarios)) return null;
    const scenarios = value.scenarios.map(s => ({
      blue: Array.isArray(s.blue) ? s.blue.map(String) : [],
      red: Array.isArray(s.red) ? s.red.map(String) : [],
    }));
    if (!scenarios.length || scenarios.some(s => s.blue.length !== 4 || s.red.length !== 4)) {
      return null;
    }
    return {
      version: 1,
      selected: Number.isInteger(value.selected) ? value.selected : 1,
      scenarios,
    };
  } catch {
    return null;
  }
}

module.exports = {
  name: "shuffle",
  description: "Admin-only: Apply a numbered Elo scenario to a live match.",
  usage: "!shuffle <matchId> [scenarioNumber]",

  async execute(message, args, ctx) {
    const { config, elo, state } = ctx;

    const adminRoleId = config.roles.admin;
    const hasAdmin = message.member?.roles?.cache?.has(adminRoleId);
    if (!hasAdmin) return message.reply("🚫 You don’t have permission to use this command.");

    const matchId = args[0];
    if (!matchId) return message.reply("Usage: `!shuffle <matchId> [scenarioNumber]`");

    const requested = args[1];
    if (requested != null && !/^\d+$/.test(String(requested))) {
      return message.reply("⚠️ The scenario must be a whole number, such as `3`.");
    }

    console.log(`[ADMIN] ${message.author.tag} used !shuffle ${matchId}${requested ? ` ${requested}` : ""}`);

    const db = elo?.db;
    if (!db?.prepare) return message.reply("❌ The Elo database is unavailable.");

    const columns = db.prepare("PRAGMA table_info(matches)").all();
    if (!columns.some(c => c.name === "team_scenarios")) {
      db.exec("ALTER TABLE matches ADD COLUMN team_scenarios TEXT");
    }

    const match = db.prepare("SELECT * FROM matches WHERE match_id = ?").get(matchId);
    if (!match) return message.reply(`❌ No match found for ID \`${matchId}\`.`);

    const status = String(match.status || "").toLowerCase();
    if (status !== "in_progress") {
      return message.reply(
        `🚫 You can only shuffle matches that are currently **in progress**.\n` +
        `This match is marked as **${match.status || "unknown"}**.`
      );
    }

    const blueIds = parseIds(match.blue_ids);
    const redIds = parseIds(match.red_ids);
    const allIds = [...blueIds, ...redIds];
    if (allIds.length !== 8 || new Set(allIds).size !== 8) {
      return message.reply("⚠️ This command only works for full 8-player matches.");
    }

    let snapshot = loadSnapshot(match.team_scenarios);
    const currentPlayerKey = [...allIds].sort().join("|");
    const snapshotMatchesPlayers = snapshot?.scenarios?.every(s =>
      [...s.blue, ...s.red].sort().join("|") === currentPlayerKey
    );
    if (!snapshotMatchesPlayers) snapshot = null;

    if (!snapshot) {
      // Backward compatibility for matches created before scenario snapshots.
      const blue = buildTeamObjects(blueIds, elo);
      const red = buildTeamObjects(redIds, elo);
      snapshot = snapshotFromScenarios(
        buildMatchScenarios(blue, red, [...blue, ...red], elo, 4),
        1
      );
    }

    const scenarioNumber = requested == null
      ? snapshot.selected + 1
      : Number(requested);

    if (scenarioNumber < 1 || scenarioNumber > snapshot.scenarios.length) {
      const nextMessage = requested == null
        ? `Scenario ${snapshot.selected} is already the last available scenario.`
        : `Choose a scenario from **1–${snapshot.scenarios.length}**.`;
      return message.reply(`⚠️ ${nextMessage}`);
    }

    const chosenIds = snapshot.scenarios[scenarioNumber - 1];
    const chosenBlue = buildTeamObjects(chosenIds.blue, elo);
    const chosenRed = buildTeamObjects(chosenIds.red, elo);
    const ratings = new Map(
      [...chosenBlue, ...chosenRed].map(p => [String(p.id), getRating(elo, p)])
    );
    const odds = summarizeSplit(chosenBlue, chosenRed, ratings);

    snapshot.selected = scenarioNumber;
    db.prepare(`
      UPDATE matches
      SET blue_ids = ?, red_ids = ?, avg_blue = ?, avg_red = ?, team_scenarios = ?
      WHERE match_id = ?
    `).run(
      JSON.stringify(chosenIds.blue),
      JSON.stringify(chosenIds.red),
      odds.avgBlue,
      odds.avgRed,
      JSON.stringify(snapshot),
      matchId
    );

    const memoryMatch = state?.matches?.find(m => String(m.id) === String(matchId));
    if (memoryMatch) {
      memoryMatch.blue_ids = JSON.stringify(chosenIds.blue);
      memoryMatch.red_ids = JSON.stringify(chosenIds.red);
      memoryMatch.blueTeam = chosenBlue.map(p => ({ id: p.id, name: p.name }));
      memoryMatch.redTeam = chosenRed.map(p => ({ id: p.id, name: p.name }));
      memoryMatch.avgBlue = odds.avgBlue;
      memoryMatch.avgRed = odds.avgRed;
    }

    const embed = new EmbedBuilder()
      .setColor(0x0088ff)
      .setTitle(`🔁 Scenario ${scenarioNumber} Applied`)
      .setDescription(
        `Match **${matchId}**\n` +
        `Elo Avg — **Blue ${odds.avgBlue}**, **Red ${odds.avgRed}** · ` +
        `Win% — **Blue ${odds.pctBlue}%**, **Red ${odds.pctRed}%**`
      )
      .addFields(
        { name: "🔵 Blue Team", value: chosenIds.blue.map(id => `<@${id}>`).join("\n"), inline: true },
        { name: "🔴 Red Team", value: chosenIds.red.map(id => `<@${id}>`).join("\n"), inline: true }
      )
      .setFooter({
        text: `Admin: ${message.author.tag} | Scenario ${scenarioNumber}/${snapshot.scenarios.length}`
      })
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  },
};
