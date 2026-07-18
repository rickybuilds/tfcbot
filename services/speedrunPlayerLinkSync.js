"use strict";

let running = false;

function normalizeSteamId(value) {
  return String(value || "").trim();
}

function sqliteUnixToMysqlDate(value) {
  const seconds = Number(value || 0);
  if (!seconds) return null;

  const date = new Date(seconds * 1000);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function syncSpeedrunPlayerLinks({ db, speedrunDb, logger = console }) {
  if (running) return { skipped: true };
  running = true;

  try {
      const sourceRows = db.prepare(`
        SELECT
          steam_id AS steamid,
          discord_id,
          COALESCE(display_name, '') AS player_name,
          created_at
        FROM player_steam_ids
        WHERE steam_id IS NOT NULL
          AND TRIM(steam_id) <> ''
          AND discord_id IS NOT NULL
          AND TRIM(discord_id) <> ''
      `).all();

    const cleanRows = sourceRows
      .map((row) => ({
        steamid: normalizeSteamId(row.steamid),
        discord_id: String(row.discord_id || "").trim(),
        player_name: row.player_name || null,
        linked_at: sqliteUnixToMysqlDate(row.created_at),
      }))
      .filter((row) => row.steamid && row.discord_id);

    const conn = await speedrunDb.getConnection();

    try {
      await conn.beginTransaction();

      let upserted = 0;

      for (const row of cleanRows) {
        await conn.execute(`
          INSERT INTO speedrun_player_links
            (steamid, discord_id, player_name, linked_at)
          VALUES
            (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
          ON DUPLICATE KEY UPDATE
            discord_id = VALUES(discord_id),
            player_name = VALUES(player_name)
        `, [row.steamid, row.discord_id, row.player_name, row.linked_at]);

        upserted += 1;
      }

      const sourceSteamIds = new Set(cleanRows.map((row) => row.steamid));

      const [existingRows] = await conn.execute(`
        SELECT steamid
        FROM speedrun_player_links
      `);

      let deleted = 0;

      for (const existing of existingRows) {
        const steamid = normalizeSteamId(existing.steamid);
        if (!steamid || sourceSteamIds.has(steamid)) continue;

        await conn.execute(`
          DELETE FROM speedrun_player_links
          WHERE steamid = ?
        `, [steamid]);

        deleted += 1;
      }

      await conn.commit();

      return { ok: true, upserted, deleted };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    logger.error("[speedrun-link-sync] failed:", err);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

function startSpeedrunPlayerLinkSync({
  db,
  speedrunDb,
  intervalMs = 5 * 60 * 1000,
  logger = console,
}) {
  if (!db) {
    logger.error("[speedrun-link-sync] missing sqlite db handle");
    return null;
  }

  if (!speedrunDb) {
    logger.error("[speedrun-link-sync] missing speedrunDb mysql pool");
    return null;
  }

  syncSpeedrunPlayerLinks({ db, speedrunDb, logger });

  return setInterval(() => {
    syncSpeedrunPlayerLinks({ db, speedrunDb, logger });
  }, intervalMs);
}

module.exports = {
  syncSpeedrunPlayerLinks,
  startSpeedrunPlayerLinkSync,
};
