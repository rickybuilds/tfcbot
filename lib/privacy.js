// lib/privacy.js
"use strict";
const Database = require("better-sqlite3");
const path = require("path");

class PrivacyDB {
  constructor(dbFile = "elo.db") {
    const full = path.resolve(process.cwd(), dbFile);
    this.db = new Database(full);

    // Keep existing table name to preserve data
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_prefs (
        player_id TEXT PRIMARY KEY,
        hide_elo  INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.getStmt = this.db.prepare(`SELECT hide_elo FROM user_prefs WHERE player_id=?`);
    this.setStmt = this.db.prepare(`
      INSERT INTO user_prefs (player_id, hide_elo) VALUES (?, ?)
      ON CONFLICT(player_id) DO UPDATE SET hide_elo=excluded.hide_elo
    `);
  }

  /** Returns true if this user's Elo is hidden */
  isHidden(playerId) {
    const row = this.getStmt.get(String(playerId));
    return row ? !!row.hide_elo : false;
  }

  /** Toggle privacy ON/OFF */
  setHidden(playerId, hidden) {
    this.setStmt.run(String(playerId), hidden ? 1 : 0);
  }
}

module.exports = { PrivacyDB };
