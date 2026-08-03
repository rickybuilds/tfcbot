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
        CREATE TABLE IF NOT EXISTS one_v_one_challenges (
          challenge_id TEXT PRIMARY KEY,
          challenger_discord_id TEXT NOT NULL,
          challenged_discord_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          accepted_at INTEGER,
          cancelled_at INTEGER,
          cancellation_reason TEXT
        );
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

  saveChallenge(challenge) {
    this.db.prepare(`INSERT INTO one_v_one_challenges
      (challenge_id, challenger_discord_id, challenged_discord_id, status, created_at, expires_at)
      VALUES (@id,@challengerId,@challengedId,@status,@createdAt,@expiresAt)
      ON CONFLICT(challenge_id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at`
    ).run(challenge);
  }

  finishChallenge(id, status, reason = null) {
    if (status === "accepted") {
      this.db.prepare(`UPDATE one_v_one_challenges SET status=?, accepted_at=? WHERE challenge_id=?`)
        .run(status, Date.now(), String(id));
    } else {
      this.db.prepare(`UPDATE one_v_one_challenges SET status=?, cancelled_at=?, cancellation_reason=? WHERE challenge_id=?`)
        .run(status, Date.now(), reason, String(id));
    }
  }

  idExists(id) {
    const value = String(id);
    return !!this.db.prepare(`SELECT 1 FROM matches WHERE match_id=?
      UNION ALL SELECT 1 FROM one_v_one_challenges WHERE challenge_id=? LIMIT 1`).get(value, value);
  }

  pendingChallenges(now = Date.now()) {
    return this.db.prepare(`SELECT challenge_id AS id, challenger_discord_id AS challengerId,
      challenged_discord_id AS challengedId, status, created_at AS createdAt, expires_at AS expiresAt
      FROM one_v_one_challenges WHERE status='pending' AND expires_at>?`).all(now);
  }

  activeDuels() {
    return this.db.prepare(`SELECT * FROM one_v_one_matches
      WHERE status NOT IN ('completed','cancelled') ORDER BY reserved_at`).all();
  }

  updateStatus(matchId, status, fields = {}) {
    const allowed = ["cancelled_at", "cancellation_reason", "started_at", "completed_at"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    const sql = [`status=?`, ...entries.map(([key]) => `${key}=?`)].join(", ");
    this.db.prepare(`UPDATE one_v_one_matches SET ${sql} WHERE match_id=?`)
      .run(status, ...entries.map(([, value]) => value), String(matchId));
    this.db.prepare("UPDATE matches SET status=? WHERE match_id=?").run(status, String(matchId));
  }

  createReservedDuel(challenge, server, config) {
    const now = Math.floor(Date.now() / 1000);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO matches
        (match_id, created_at, map_name, server_name, blue_ids, red_ids, winner, processed_at, status,
         match_type, player_format, expected_players, scoring_mode)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(challenge.id, now, config.map, server.name, JSON.stringify([challenge.challengerId]),
          JSON.stringify([challenge.challengedId]), null, null, "reserved", "1v1", "1v1_dm", 2, "kill_goal");
      this.db.prepare(`INSERT INTO one_v_one_matches
        (match_id, challenger_discord_id, challenged_discord_id, player1_steam_id, player2_steam_id,
         server_key, server_ip, kill_goal, rounds_required, scoring_mode, status, challenge_created_at,
         accepted_at, reserved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(challenge.id, challenge.challengerId, challenge.challengedId, challenge.player1SteamId,
          challenge.player2SteamId, server.key || null, server.ip, config.killGoal, config.roundsToWin,
          "kill_goal", "reserved", challenge.createdAt, Date.now(), Date.now());
    })();
  }
}

module.exports = { OneVOneStore };
