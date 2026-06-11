"use strict";

const sqlite3 = require("sqlite3").verbose();

const DB_PATH = "/root/tfcbot/elo.db";
const STEAM_RE = /^STEAM_[0-5]:[01]:\d+$/;

function isValidSteamId(steamId) {
  return STEAM_RE.test(String(steamId || "").trim());
}

class SteamLinks {
  constructor(dbPath = DB_PATH) {
    this.db = new sqlite3.Database(dbPath);
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

    return this.run(
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
  }

  async unlinkSteam(discordId, steamId) {
    return this.run(
      `DELETE FROM player_steam_ids
       WHERE discord_id=?
         AND steam_id=?`,
      [String(discordId), String(steamId).trim()]
    );
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
    this.db.close();
  }
}

module.exports = {
  SteamLinks,
  isValidSteamId,
  DB_PATH
};
