"use strict";

const Database = require("better-sqlite3");

const DEFAULT_DB_PATH = process.env.DB_PATH || "/root/tfcbot/elo.db";

class PlayerIdentityStore {
  constructor(dbPath = DEFAULT_DB_PATH, db = null) {
    this.db = db || new Database(dbPath);
    this.ownsDatabase = !db;

    this.upsertIdentity = this.db.prepare(`
      INSERT INTO player_identities (
        steam_id,
        discord_id,
        current_name,
        current_ip,
        current_server,
        first_seen,
        last_seen,
        last_connect_at,
        last_disconnect_at,
        connection_count,
        created_at,
        updated_at
      )
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET
        current_name = excluded.current_name,
        current_ip = excluded.current_ip,
        current_server = excluded.current_server,
        last_seen = excluded.last_seen,
        last_connect_at = excluded.last_connect_at,
        connection_count = COALESCE(player_identities.connection_count, 0) + 1,
        updated_at = excluded.updated_at
    `);

    this.upsertAlias = this.db.prepare(`
      INSERT INTO steam_alias_history (
        steam_id,
        alias,
        first_seen,
        last_seen,
        times_seen
      )
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(steam_id, alias) DO UPDATE SET
        last_seen = excluded.last_seen,
        times_seen = COALESCE(steam_alias_history.times_seen, 0) + 1
    `);

    this.syncDiscordId = this.db.prepare(`
      UPDATE player_identities
      SET
        discord_id = (
          SELECT psi.discord_id
          FROM player_steam_ids psi
          WHERE psi.steam_id = player_identities.steam_id
          LIMIT 1
        ),
        updated_at = ?
      WHERE steam_id = ?
    `);

    this.upsertIp = this.db.prepare(`
      INSERT INTO steam_ip_history (
        steam_id,
        ip,
        first_seen,
        last_seen,
        times_seen
      )
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(steam_id, ip) DO UPDATE SET
        last_seen = excluded.last_seen,
        times_seen = COALESCE(steam_ip_history.times_seen, 0) + 1
    `);

    this.updateDisconnect = this.db.prepare(`
      UPDATE player_identities
      SET
        last_disconnect_at = ?,
        last_seen = ?,
        updated_at = ?
      WHERE steam_id = ?
    `);

    this.recordConnectTransaction = this.db.transaction((event) => {
      this.upsertIdentity.run(
        event.steamId,
        event.alias,
        event.ip,
        event.server,
        event.timestamp,
        event.timestamp,
        event.timestamp,
        event.timestamp,
        event.timestamp
      );
      this.syncDiscordId.run(event.timestamp, event.steamId);
      this.upsertAlias.run(
        event.steamId,
        event.alias,
        event.timestamp,
        event.timestamp
      );
      this.upsertIp.run(
        event.steamId,
        event.ip,
        event.timestamp,
        event.timestamp
      );
    });
  }

  recordConnect(event) {
    this.recordConnectTransaction(event);
  }

  recordDisconnect(steamId, timestamp) {
    this.updateDisconnect.run(timestamp, timestamp, timestamp, steamId);
  }

  close() {
    if (this.ownsDatabase) this.db.close();
  }
}

module.exports = {
  PlayerIdentityStore,
  DEFAULT_DB_PATH,
};
