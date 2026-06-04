"use strict";
const Database = require("better-sqlite3");

const db = new Database("elo.db");
db.pragma("journal_mode=WAL");

const uid = process.argv[2]; // pass your user id
if (!uid) {
  console.log("Usage: node scripts/peek-elo.js <discordUserId>");
  process.exit(1);
}

const rows = db.prepare(`
  SELECT match_id, ts, before, after, delta
  FROM rating_changes
  WHERE player_id = ?
  ORDER BY ts DESC
`).all(String(uid));

console.log(`Found ${rows.length} rating_changes for ${uid}`);
for (const r of rows) {
  const when = new Date((Number(r.ts)||0) * 1000).toISOString();
  console.log(`${when} | match ${r.match_id} | ${r.before} -> ${r.after} (Δ ${r.delta})`);
}
