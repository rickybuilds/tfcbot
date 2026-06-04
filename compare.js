// elo_compare_kdcurve.js
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.resolve(process.cwd(), "elo.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* ---------------- Configuration ---------------- */
const DIVISORS = [400, 300, 200];
const K_FACTORS = [32, 40, 48];

function expectedScore(rA, rB, divisor) {
  return 1 / (1 + 10 ** ((rB - rA) / divisor));
}

function safeJSON(v) {
  try { return JSON.parse(v || "[]"); } catch { return []; }
}

/* ---------------- Load recent matches ---------------- */
const matches = db.prepare(`
  SELECT match_id, map_name, blue_ids, red_ids, winner
  FROM matches
  WHERE status='completed'
  ORDER BY rowid DESC
  LIMIT 10
`).all();

if (!matches.length) {
  console.error("⚠️ No completed matches found in elo.db.");
  process.exit(0);
}

const getRating = db.prepare("SELECT rating FROM ratings WHERE player_id=?");

for (const m of matches) {
  const blueIds = safeJSON(m.blue_ids);
  const redIds  = safeJSON(m.red_ids);
  const winner  = (m.winner || "").toLowerCase();

  const blueRatings = blueIds.map(id => getRating.get(String(id))?.rating || 1441);
  const redRatings  = redIds.map(id => getRating.get(String(id))?.rating || 1441);

  const avg = arr => arr.reduce((a, x) => a + x, 0) / arr.length;
  const avgBlue = avg(blueRatings);
  const avgRed  = avg(redRatings);

  const scoreBlue = winner === "blue" ? 1 : winner === "tie" ? 0.5 : 0;
  const scoreRed  = 1 - scoreBlue;

  console.log("\n==============================");
  console.log(`🏁 ${m.match_id} — ${m.map_name}`);
  console.log(`Winner: ${winner.toUpperCase()}`);
  console.log(`AvgBlue ${avgBlue.toFixed(0)} vs AvgRed ${avgRed.toFixed(0)}\n`);

  // Print header row
  const header = ["Div ↓ / K →", ...K_FACTORS.map(k => `K=${k}`)];
  console.log(header.join("\t"));

  for (const D of DIVISORS) {
    const expBlue = expectedScore(avgBlue, avgRed, D);
    const expRed  = 1 - expBlue;

    const row = [`D=${D}`];
    for (const K of K_FACTORS) {
      const deltaBlue = Math.round(K * (scoreBlue - expBlue));
      const deltaRed  = Math.round(K * (scoreRed  - expRed));
      row.push(`+${deltaBlue}/-${Math.abs(deltaRed)}`);
    }
    console.log(row.join("\t"));
  }
}

db.close();
