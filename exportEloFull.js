/**
 * exportEloFull.js
 * 
 * Stand-alone script — DOES NOT require the bot or Discord.
 * Generates a FULL Elo history CSV for ALL PLAYERS.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---- adjust this if your elo DB wrapper lives elsewhere ----
const elo = require("./lib/elo"); 
// If your elo object is normally injected via deps,
// replace this require with the exact file your main bot loads.

const csvEscape = (s) => {
  if (s == null) return "";
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

function isoFrom(ts) {
  if (!ts && ts !== 0) return new Date().toISOString();
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  return new Date(ts).toISOString();
}

function headerLine() {
  return [
    "PlayerId",
    "DisplayName",
    "GameIndex",
    "Date",
    "MatchId",
    "Map",
    "Server",
    "Team",
    "Teammates",
    "Opponents",
    "Winner",
    "Before",
    "Delta",
    "After"
  ].join(",");
}

function rowsToCsv(rows) {
  return (
    headerLine() +
    "\n" +
    rows.map((r) => r.map(csvEscape).join(",")).join("\n")
  );
}

(async () => {
  console.log("📊 Exporting full Elo history...");

  try {
    /* ------------------------------------------------------------
     * Load display names
     * ------------------------------------------------------------ */
    const playerNames = new Map();
    const players = elo.db
      .prepare("SELECT player_id, display_name FROM ratings")
      .all();

    for (const p of players) {
      playerNames.set(String(p.player_id), p.display_name || "Unknown");
    }

    /* ------------------------------------------------------------
     * Load all rating changes with match data
     * ------------------------------------------------------------ */
    const eloRows = elo.db
      .prepare(
        `SELECT 
            rc.player_id,
            rc.match_id,
            rc.before,
            rc.after,
            rc.delta,
            rc.ts,
            m.map_name,
            m.server_name,
            m.blue_ids,
            m.red_ids,
            m.winner
         FROM rating_changes rc
         LEFT JOIN matches m ON rc.match_id = m.match_id
         ORDER BY rc.ts ASC, rc.rowid ASC`
      )
      .all();

    let rows = [];
    let matchCounter = {}; // per-player GameIndex counter

    for (const r of eloRows) {
      const pid = String(r.player_id);
      const mid = String(r.match_id || "");

      if (!mid || mid.startsWith("seed-") || mid.startsWith("admin")) continue;

      if (!matchCounter[pid]) matchCounter[pid] = 0;
      matchCounter[pid] += 1;

      let blue = [],
        red = [];
      try {
        blue = JSON.parse(r.blue_ids || "[]");
        red = JSON.parse(r.red_ids || "[]");
      } catch {}

      const onBlue = blue.includes(pid);
      const onRed = red.includes(pid);
      const team = onBlue ? "Blue" : onRed ? "Red" : "";

      const teammates = onBlue
        ? blue.filter((id) => id !== pid)
        : onRed
        ? red.filter((id) => id !== pid)
        : [];

      const opponents = onBlue ? red : onRed ? blue : [];

      const teammateNames = teammates
        .map((id) => playerNames.get(String(id)) || id)
        .join(", ");

      const opponentNames = opponents
        .map((id) => playerNames.get(String(id)) || id)
        .join(", ");

      let winner = (r.winner || "").trim();
      if (!winner) {
        if (r.delta > 0) winner = "Win";
        else if (r.delta < 0) winner = "Loss";
        else winner = "Tie";
      }

      rows.push([
        pid,
        playerNames.get(pid) || pid,
        matchCounter[pid],
        isoFrom(r.ts),
        mid,
        r.map_name || "",
        r.server_name || "",
        team,
        teammateNames,
        opponentNames,
        winner,
        r.before ?? "",
        r.delta ?? "",
        r.after ?? "",
      ]);
    }

    const csv = rowsToCsv(rows);
    const outputPath = path.join(__dirname, "elo_full_export.csv");

    fs.writeFileSync(outputPath, csv, "utf8");

    console.log("✅ Export complete!");
    console.log("📁 File saved to:", outputPath);
    console.log("📊 Rows exported:", rows.length);
  } catch (err) {
    console.error("❌ ERROR EXPORTING:", err);
  }
})();
