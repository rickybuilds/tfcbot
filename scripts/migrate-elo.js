// scripts/migrate-elo.js
"use strict";
const Database = require("better-sqlite3");

const db = new Database("elo.db");
db.pragma("journal_mode = WAL");

db.exec(`
BEGIN;
CREATE TABLE IF NOT EXISTS rating_changes (
  id            INTEGER PRIMARY KEY,
  player_id     TEXT NOT NULL,
  match_id      TEXT,
  map           TEXT,
  server        TEXT,
  ts            INTEGER NOT NULL,
  delta         INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rc_player_ts ON rating_changes(player_id, ts);
CREATE INDEX IF NOT EXISTS rc_match     ON rating_changes(match_id);
COMMIT;
`);

console.log("✅ rating_changes table ensured.");
