// scripts/resetWinStreaks.js
// Reset win-streaks stored in bot.db (lib/winstreak.js)
//
// Usage:
//   node scripts/resetWinStreaks.js --all
//   node scripts/resetWinStreaks.js --user=123456789012345678
//   node scripts/resetWinStreaks.js --pattern="rick%"          // player_id LIKE 'rick%'
//   node scripts/resetWinStreaks.js --db="bot.db"
//
// Notes:
// - Streaks are stored in table: win_streaks(player_id TEXT PRIMARY KEY, streak INTEGER, last_ts INTEGER)

"use strict";
const path = require("path");
const Database = require("better-sqlite3");

function arg(flag, def=null){
  const hit = process.argv.find(a => a.startsWith(flag));
  if (!hit) return def;
  const [,v] = hit.split("=");
  return v === undefined ? true : v;
}

const DB_PATH = arg("--db", path.resolve(process.cwd(), "bot.db"));
const USER    = arg("--user", null);
const ALL     = !!arg("--all", false);
const PATTERN = arg("--pattern", null);

if (!ALL && !USER && !PATTERN) {
  console.log("Usage:");
  console.log("  node scripts/resetWinStreaks.js --all");
  console.log("  node scripts/resetWinStreaks.js --user=<discord_id>");
  console.log('  node scripts/resetWinStreaks.js --pattern="rick%"');
  process.exit(1);
}

const db = new Database(DB_PATH);

function hasTable(name){
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch { return false; }
}

if (!hasTable("win_streaks")) {
  console.log("No win_streaks table found in", DB_PATH);
  process.exit(0);
}

if (ALL) {
  const res = db.prepare(`DELETE FROM win_streaks`).run();
  console.log(`Cleared ALL win streaks (${res.changes} row(s)).`);
  process.exit(0);
}

if (USER) {
  const res = db.prepare(`DELETE FROM win_streaks WHERE player_id=?`).run(String(USER));
  console.log(`Cleared win streak for player_id=${USER} (${res.changes} row).`);
  process.exit(0);
}

if (PATTERN) {
  const res = db.prepare(`DELETE FROM win_streaks WHERE player_id LIKE ?`).run(PATTERN);
  console.log(`Cleared win streaks matching pattern "${PATTERN}" (${res.changes} row(s)).`);
  process.exit(0);
}
