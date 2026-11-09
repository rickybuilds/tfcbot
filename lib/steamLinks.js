"use strict";

const DB_PATH = "/root/tfcbot/elo.db";
const STEAM_RE = /^STEAM_[0-5]:[01]:\d+$/;
let sqlite3 = null;

function isValidSteamId(steamId) {
  return STEAM_RE.test(String(steamId || "").trim());
}

class SteamLinks {
  constructor(dbPath = DB_PATH, db = null) {
    this.ownsDatabase = !db;
    if (!db) {
      sqlite3 ||= require("sqlite3").verbose();
      db = new sqlite3.Database(dbPath);
    }
    this.db = db;
    this.bootcampLearningQueueSchema = null;
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  async getSteamIds(discordId) {
    return this.all(
      `SELECT steam_id, display_name, is_primary, notes, created_at, updated_at
       FROM player_steam_ids
       WHERE discord_id=?
       ORDER BY is_primary DESC, steam_id ASC`,
      [String(discordId)]
    );
  }

  async ensureBootcampLearningQueueSchema() {
    if (!this.bootcampLearningQueueSchema) {
      this.bootcampLearningQueueSchema = this.run(`
        CREATE TABLE IF NOT EXISTS bootcamp_learning_queue (
          discord_id TEXT PRIMARY KEY,
          steam_id TEXT NOT NULL,
          joined_at INTEGER NOT NULL
        )
      `).catch(error => {
        this.bootcampLearningQueueSchema = null;
        throw error;
      });
    }
    return this.bootcampLearningQueueSchema;
  }

  async joinBootcampLearningQueue(discordId, steamId, joinedAt = Math.floor(Date.now() / 1000), maxPlayers = 8) {
    discordId = String(discordId || "").trim();
    steamId = String(steamId || "").trim();
    if (!/^\d{17,20}$/.test(discordId)) throw new Error("Invalid Discord ID");
    if (!isValidSteamId(steamId)) throw new Error("Invalid Steam ID");
    await this.ensureBootcampLearningQueueSchema();
    return this.run(`
      INSERT INTO bootcamp_learning_queue(discord_id, steam_id, joined_at)
      SELECT ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM player_steam_ids WHERE discord_id = ? AND steam_id = ?)
         AND (EXISTS (SELECT 1 FROM bootcamp_learning_queue WHERE discord_id = ?)
              OR (SELECT COUNT(*) FROM bootcamp_learning_queue q
                   JOIN player_steam_ids p ON p.discord_id = q.discord_id AND p.steam_id = q.steam_id) < ?)
      ON CONFLICT(discord_id) DO UPDATE SET steam_id = excluded.steam_id
    `, [discordId, steamId, Number(joinedAt), discordId, steamId, discordId, Math.max(1, Number(maxPlayers) || 8)]);
  }

  async leaveBootcampLearningQueue(discordId) {
    await this.ensureBootcampLearningQueueSchema();
    return this.run("DELETE FROM bootcamp_learning_queue WHERE discord_id = ?", [String(discordId || "").trim()]);
  }

  async clearBootcampLearningQueue() {
    await this.ensureBootcampLearningQueueSchema();
    return this.run("DELETE FROM bootcamp_learning_queue");
  }

  async getBootcampLearningQueue() {
    await this.ensureBootcampLearningQueueSchema();
    return this.all(`
      SELECT q.discord_id, q.steam_id, q.joined_at, p.display_name
        FROM bootcamp_learning_queue q
        JOIN player_steam_ids p ON p.discord_id = q.discord_id AND p.steam_id = q.steam_id
       ORDER BY q.joined_at ASC, q.rowid ASC
    `);
  }

async getDiscordBySteam(steamId) {
  return this.all(
    `SELECT discord_id, steam_id, display_name, is_primary, notes, created_at, updated_at
     FROM player_steam_ids
     WHERE steam_id=?
     ORDER BY is_primary DESC, display_name ASC`,
    [String(steamId).trim()]
  );
}

async getPlayerName(discordId) {
  return this.get(
    `SELECT display_name
     FROM ratings
     WHERE player_id=?`,
    [String(discordId)]
  );
}

  async linkSteam(discordId, steamId, displayName = null, notes = "manual admin link", isPrimary = 1) {
    steamId = String(steamId || "").trim();

    if (!isValidSteamId(steamId)) {
      throw new Error("Invalid Steam ID. Use format STEAM_0:1:12345");
    }

    const result = await this.run(
      `INSERT INTO player_steam_ids
       (discord_id, steam_id, display_name, is_primary, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
       ON CONFLICT(discord_id, steam_id) DO UPDATE SET
         display_name=excluded.display_name,
         is_primary=excluded.is_primary,
         notes=excluded.notes,
         updated_at=strftime('%s','now')`,
      [String(discordId), steamId, displayName, Number(isPrimary) ? 1 : 0, notes]
    );

    await this.run(
      `UPDATE player_identities
       SET discord_id=?
       WHERE steam_id=?`,
      [String(discordId), steamId]
    );

    return result;
  }

  async unlinkSteam(discordId, steamId) {
    return this.run(
      `DELETE FROM player_steam_ids
       WHERE discord_id=?
         AND steam_id=?`,
      [String(discordId), String(steamId).trim()]
    );
  }

  async claimBootcampAccountLinkSync(now = Math.floor(Date.now() / 1000)) {
    const staleBefore = Number(now) - 120;
    const candidate = await this.get(`
      SELECT id, discord_id, steam_id, attempts
        FROM bootcamp_account_link_outbox
       WHERE (status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'processing' AND updated_at <= ?)
       ORDER BY id LIMIT 1
    `, [Number(now), staleBefore]);
    if (!candidate) return null;
    const claimed = await this.run(`
      UPDATE bootcamp_account_link_outbox
         SET status = 'processing', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?)
          OR (status = 'processing' AND updated_at <= ?))
    `, [Number(now), candidate.id, Number(now), staleBefore]);
    return claimed.changes === 1 ? { ...candidate, attempts: Number(candidate.attempts || 0) + 1 } : null;
  }

  async completeBootcampAccountLinkSync(id, now = Math.floor(Date.now() / 1000)) {
    return this.run(`UPDATE bootcamp_account_link_outbox
      SET status = 'done', last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'processing'`, [Number(now), Number(id)]);
  }

  async retryBootcampAccountLinkSync(id, attempts, errorCode = "sync_failed", now = Math.floor(Date.now() / 1000)) {
    const retrySeconds = Math.min(3600, 15 * (2 ** Math.min(8, Math.max(0, Number(attempts || 1) - 1))));
    const safeCode = String(errorCode || "sync_failed").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "sync_failed";
    return this.run(`UPDATE bootcamp_account_link_outbox
      SET status = 'pending', next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'`, [Number(now) + retrySeconds, safeCode, Number(now), Number(id)]);
  }

  async getMissingLinks(limit = 50) {
    return this.all(
      `SELECT
         r.player_id AS discord_id,
         r.display_name,
         r.rating
       FROM ratings r
       LEFT JOIN player_steam_ids psi
         ON psi.discord_id = r.player_id
       WHERE psi.discord_id IS NULL
       ORDER BY r.rating DESC
       LIMIT ?`,
      [Number(limit) || 50]
    );
  }

  async getLinkProgress() {
  const row = await this.get(
    `SELECT
       (SELECT COUNT(*) FROM ratings) AS discord_players,
       (SELECT COUNT(DISTINCT steam_id) FROM match_player_stats) AS unique_steam_ids,
       (SELECT COUNT(DISTINCT discord_id) FROM player_steam_ids) AS linked_players,
       (
         SELECT COUNT(*)
         FROM ratings r
         LEFT JOIN player_steam_ids psi
           ON psi.discord_id = r.player_id
         WHERE psi.discord_id IS NULL
       ) AS missing_players,
       (SELECT COUNT(*) FROM player_steam_ids) AS total_links`
  );

  return row;
}

  close() {
    if (this.ownsDatabase) this.db.close();
  }
}

module.exports = {
  SteamLinks,
  isValidSteamId,
  DB_PATH
};
