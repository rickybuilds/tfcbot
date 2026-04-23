// commands/matches.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { guardChannel } = require("../lib/guards");
const elo = require("../lib/elo"); // elo.db handle
const config = require("../config");

/* ─────────── helpers ─────────── */

function displayName(pid) {
  try {
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

/* ─────────── register ─────────── */

function register(reg) {
  // !lastmatches [limit]
  reg.set("lastmatches", async (message, args) => {
    if (!(await guardChannel(message, config.channels.pickup))) return;
    const limit = Math.min(10, Number(args?.[0]) || 5);
    try {
      const rows = elo.db
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
  });
}

module.exports = { register, getTeamsFromMatches, formatMatchEmbed };
