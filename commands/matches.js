// commands/matches.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { guardChannel } = require("../lib/guards");
const config = require("../config");

function getElo() {
  return require("../lib/elo");
}

/* ─────────── helpers ─────────── */

function displayName(pid) {
  try {
    const elo = getElo();
    const r = elo.db
      .prepare("SELECT display_name FROM ratings WHERE player_id=?")
      .get(String(pid));
    return r?.display_name || String(pid);
  } catch {
    return String(pid);
  }
}

// decode teams from unified matches table
function getTeamsFromMatches(mid) {
  try {
    const elo = getElo();
    const row = elo.db
      .prepare(
        `SELECT map_name, server_name, mode, blue_ids, red_ids, avg_blue, avg_red
         FROM matches WHERE match_id=?`
      )
      .get(String(mid));
    if (!row) return { blue: [], red: [], meta: {} };

    const fetchBefore = elo.db.prepare(
      "SELECT rating FROM ratings WHERE player_id=?"
    );
    const parse = (json) => {
      try {
        return JSON.parse(json || "[]");
      } catch {
        return [];
      }
    };
    const enrich = (id) => {
      let before = null;
      try {
        before = fetchBefore.get(String(id))?.rating ?? null;
      } catch {}
      return { id: String(id), name: displayName(id), before };
    };

    const blue = parse(row.blue_ids).map(enrich);
    const red = parse(row.red_ids).map(enrich);

    return {
      blue,
      red,
      meta: {
        map_name: row.map_name,
        server_name: row.server_name,
        mode: row.mode,
        avg_blue: row.avg_blue,
        avg_red: row.avg_red,
      },
    };
  } catch (e) {
    console.error("[getTeamsFromMatches]", e);
    return { blue: [], red: [], meta: {} };
  }
}

function formatMatchEmbed(mid, outcome, meta, blue, red, avgBlue, avgRed) {
  const nameList = (arr) =>
    arr.map((p) => `${p.name} (${p.before ?? "?"})`).join("\n") || "_none_";

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(
      `Match Reported — ${meta.map_name || "(unknown)"} — ID: ${mid}`
    )
    .setDescription(
      `Result: **${(outcome || "—").toUpperCase()}**\n` +
        `Mode: **${meta.mode || "STANDARD"}** · Avg: Blue ${
          avgBlue ?? "?"
        } / Red ${avgRed ?? "?"}`
    )
    .addFields(
      { name: "Blue Team 🔵", value: nameList(blue), inline: true },
      { name: "Red Team 🔴", value: nameList(red), inline: true }
    )
    .setTimestamp();
}

function getLastMatchesLimit(args) {
  return Math.min(10, Number(args?.[0]) || 7);
}

const PLAYER_GAME_INDICATORS = Object.freeze({
  win: { emoji: "🟢" },
  win_mvp: { emoji: "🟣" },
  tie: { emoji: "🟡" },
  tie_mvp: { emoji: "😐" },
  loss: { emoji: "🔴" },
  loss_mvp: { emoji: "😢" },
});

function parseIds(value) {
  try {
    const ids = JSON.parse(value || "[]");
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function getPlayerGameState(row, playerId, isMvp = false) {
  const id = String(playerId);
  const blueIds = parseIds(row?.blue_ids);
  const redIds = parseIds(row?.red_ids);
  const team = blueIds.includes(id) ? "blue" : redIds.includes(id) ? "red" : null;
  const winner = String(row?.winner || "").toLowerCase();
  const result = winner === "tie" || winner === "draw"
    ? "tie"
    : winner === team
      ? "win"
      : "loss";
  return isMvp ? `${result}_mvp` : result;
}

function getPlayerGameButtonSpec(state) {
  return PLAYER_GAME_INDICATORS[state] || PLAYER_GAME_INDICATORS.loss;
}

function getPlayerGameRecord(games) {
  const record = { win: 0, loss: 0, tie: 0 };
  for (const game of games) {
    const result = String(game.state || "").replace(/_mvp$/, "");
    if (result in record) record[result]++;
  }
  return `${record.win}-${record.loss}-${record.tie}`;
}

function formatPlayerLastGames(games) {
  const indicators = games
    .map(game => getPlayerGameButtonSpec(game.state).emoji)
    .join(" ");
  return `Last ${games.length}: ${indicators} W-L-T(${getPlayerGameRecord(games)})`;
}

function getPlayerLastGames(database, playerId) {
  const id = String(playerId);
  const rows = database
    .prepare(
      `SELECT match_id, winner, created_at, map_name, status, blue_ids, red_ids
       FROM matches
       WHERE status = 'completed'
         AND (
           EXISTS (SELECT 1 FROM json_each(COALESCE(blue_ids, '[]')) WHERE CAST(value AS TEXT) = ?)
           OR EXISTS (SELECT 1 FROM json_each(COALESCE(red_ids, '[]')) WHERE CAST(value AS TEXT) = ?)
         )
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(id, id);

  const mvpMatches = new Set();
  try {
    const linkedSteamIds = new Set(
      database
        .prepare("SELECT steam_id FROM player_steam_ids WHERE discord_id=?")
        .all(id)
        .map(row => String(row.steam_id || "").trim().toUpperCase())
        .filter(Boolean)
    );

    if (linkedSteamIds.size && rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      const mvpRows = database
        .prepare(
          `SELECT match_id, mvp_player_key, steam_id
           FROM match_round_mvps
           WHERE match_id IN (${placeholders})`
        )
        .all(...rows.map(row => row.match_id));

      for (const row of mvpRows) {
        const keys = [row.mvp_player_key, row.steam_id]
          .map(value => String(value || "").trim().toUpperCase())
          .filter(Boolean);
        if (keys.some(key => linkedSteamIds.has(key))) mvpMatches.add(String(row.match_id));
      }
    }
  } catch (error) {
    // Older databases may not have link or MVP tables yet.
    console.warn("[lastplayer] MVP lookup unavailable:", error.message);
  }

  return rows.map(row => ({
    ...row,
    state: getPlayerGameState(row, id, mvpMatches.has(String(row.match_id))),
  }));
}

/* ─────────── register ─────────── */

function register(reg, deps = {}) {
  // !lastmatches, !lastgames [limit]
  const showLastMatches = async (message, args) => {
    const pickupChannel = deps.config?.channels?.pickup ?? config.channels.pickup;
    if (!(await guardChannel(message, pickupChannel))) return;
    const limit = getLastMatchesLimit(args);
    try {
      const database = deps.elo?.db || getElo().db;
      const rows = database
        .prepare(
          `SELECT match_id, winner, created_at, map_name, status
           FROM matches ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit);

      if (!rows.length) return message.channel.send("No matches found.");
      const out = rows.map(
        (r) =>
          `\`${r.match_id}\` → Winner: ${r.winner || "—"} — Status: ${
            r.status || "?"
          } — ${r.map_name || "(unknown)"} — ${new Date(
            (r.created_at || 0) * 1000
          ).toLocaleString()}`
      );
      await message.channel.send("📊 Recent Matches:\n" + out.join("\n"));
    } catch (e) {
      console.error("[lastmatches]", e);
      await message.channel.send("Error fetching matches.");
    }
  };

  const showPlayerLastGames = async (message, target) => {
    const pickupChannel = deps.config?.channels?.pickup ?? config.channels.pickup;
    if (!(await guardChannel(message, pickupChannel))) return;

    try {
      const database = deps.elo?.db || getElo().db;
      const games = getPlayerLastGames(database, target.id);
      if (!games.length) {
        return message.channel.send(`No completed games found for <@${target.id}>.`);
      }

      await message.channel.send(formatPlayerLastGames(games));
    } catch (e) {
      console.error("[lastplayer]", e);
      await message.channel.send("Error fetching player games.");
    }
  };

  const showLast = async (message, args) => {
    const target = message.mentions?.users?.first?.();
    if (target) return showPlayerLastGames(message, target);
    return showLastMatches(message, args);
  };

  reg.set("lastmatches", showLastMatches);
  reg.set("lastgames", showLastMatches);
  reg.set("last", showLast);
}

module.exports = {
  register,
  getTeamsFromMatches,
  formatMatchEmbed,
  getLastMatchesLimit,
  getPlayerGameState,
  getPlayerGameButtonSpec,
  getPlayerGameRecord,
  formatPlayerLastGames,
  getPlayerLastGames,
};
