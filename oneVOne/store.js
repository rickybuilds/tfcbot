"use strict";

class OneVOneStore {
  constructor(db) {
    if (!db || typeof db.prepare !== "function") throw new Error("OneVOneStore requires a better-sqlite3 database");
    this.db = db;
  }

  schemaStatus() {
    const columns = this.db.prepare("PRAGMA table_info(matches)").all().map(row => row.name);
    const duelTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='one_v_one_matches'").get();
    return {
      matchType: columns.includes("match_type"),
      playerFormat: columns.includes("player_format"),
      expectedPlayers: columns.includes("expected_players"),
      scoringMode: columns.includes("scoring_mode"),
      duelTable: !!duelTable,
    };
  }

  migrate() {
    const addColumn = (name, sql) => {
      const columns = this.db.prepare("PRAGMA table_info(matches)").all();
      if (!columns.some(row => row.name === name)) this.db.exec(sql);
    };
    const tx = this.db.transaction(() => {
      addColumn("match_type", "ALTER TABLE matches ADD COLUMN match_type TEXT NOT NULL DEFAULT 'pickup'");
      addColumn("player_format", "ALTER TABLE matches ADD COLUMN player_format TEXT NOT NULL DEFAULT '4v4'");
      addColumn("expected_players", "ALTER TABLE matches ADD COLUMN expected_players INTEGER NOT NULL DEFAULT 8");
      addColumn("scoring_mode", "ALTER TABLE matches ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'rounds'");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS one_v_one_matches (
          match_id TEXT PRIMARY KEY,
          challenger_discord_id TEXT NOT NULL,
          challenged_discord_id TEXT NOT NULL,
          player1_steam_id TEXT NOT NULL,
          player2_steam_id TEXT NOT NULL,
          server_key TEXT,
          server_ip TEXT,
          kill_goal INTEGER,
          rounds_required INTEGER NOT NULL DEFAULT 1,
          winner_steam_id TEXT,
          loser_steam_id TEXT,
          winner_score INTEGER,
          loser_score INTEGER,
          duration_seconds INTEGER,
          scoring_mode TEXT NOT NULL DEFAULT 'kill_goal',
          status TEXT NOT NULL DEFAULT 'pending',
          challenge_created_at INTEGER,
          accepted_at INTEGER,
          reserved_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          cancelled_at INTEGER,
          cancellation_reason TEXT,
          FOREIGN KEY (match_id) REFERENCES matches(match_id)
        );
        CREATE INDEX IF NOT EXISTS idx_matches_match_type ON matches(match_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_1v1_player1 ON one_v_one_matches(player1_steam_id, completed_at);
        CREATE INDEX IF NOT EXISTS idx_1v1_player2 ON one_v_one_matches(player2_steam_id, completed_at);
      `);
    });
    tx();
    return this.schemaStatus();
  }
}

module.exports = { OneVOneStore };
