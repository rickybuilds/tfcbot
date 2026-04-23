"use strict";
const Database = require("better-sqlite3");

class BanStore {
  constructor(file = "bot.db") {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS game_bans (
        user_id        TEXT PRIMARY KEY,
        games_remaining INTEGER NOT NULL,
        reason          TEXT,
        banned_at       INTEGER NOT NULL
      );
    `);
  }

  /** Add or update a ban */
  upsertBan(userId, gamesRemaining, reason = "unspecified") {
    this.db.prepare(`
      INSERT INTO game_bans (user_id, games_remaining, reason, banned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        games_remaining = excluded.games_remaining,
        reason = excluded.reason,
        banned_at = excluded.banned_at
    `).run(String(userId), Number(gamesRemaining), String(reason), Date.now());
  }

  /** Remove ban */
  deleteBan(userId) {
    this.db.prepare(`DELETE FROM game_bans WHERE user_id = ?`).run(String(userId));
  }

  /** Get one player’s ban */
  getBan(userId) {
    return this.db.prepare(`
      SELECT user_id AS userId, games_remaining AS gamesRemaining, reason, banned_at AS bannedAt
      FROM game_bans WHERE user_id = ?
    `).get(String(userId));
  }

  /** All active bans */
  getAllBans() {
    return this.db.prepare(`
      SELECT user_id AS userId, games_remaining AS gamesRemaining, reason, banned_at AS bannedAt
      FROM game_bans
    `).all();
  }

  /** Decrement a ban (called after a match is completed) */
  decrementBan(userId) {
    const ban = this.getBan(userId);
    if (!ban) return null;

    const remaining = ban.gamesRemaining - 1;
    if (remaining <= 0) {
      this.deleteBan(userId);
      return null;
    } else {
      this.db.prepare(`
        UPDATE game_bans SET games_remaining = ? WHERE user_id = ?
      `).run(remaining, String(userId));
      return { ...ban, gamesRemaining: remaining };
    }
  }
}

module.exports = { BanStore };
