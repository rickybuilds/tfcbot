// lib/winstreak.js
"use strict";
const Database = require("better-sqlite3");
const path = require("path");

class WinStreakStore {
  constructor(eloDbFile = "/root/tfcbot/elo.db") {
    this.db = new Database(eloDbFile, { readonly: true });
  }

  /**
   * get the current active streak for a single player
   */
  get(playerId) {
    const sql = `
      WITH ordered AS (
        SELECT
          rc.player_id,
          m.winner,
          CASE
            WHEN m.winner='BLUE' AND EXISTS (
              SELECT 1 FROM json_each(m.blue_ids) WHERE CAST(value AS TEXT) = rc.player_id
            ) THEN 1
            WHEN m.winner='RED' AND EXISTS (
              SELECT 1 FROM json_each(m.red_ids) WHERE CAST(value AS TEXT) = rc.player_id
            ) THEN 1
            ELSE 0
          END AS is_win,
          m.created_at
        FROM rating_changes rc
        JOIN matches m ON m.match_id = rc.match_id
        WHERE m.status='completed' AND rc.player_id = ?
        ORDER BY m.created_at ASC
      ),
      reset_streaks AS (
        SELECT
          SUM(CASE WHEN is_win=0 THEN 1 ELSE 0 END)
            OVER (ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          AS reset_grp,
          is_win,
          created_at
        FROM ordered
      ),
      current_count AS (
        SELECT COUNT(*) AS current
        FROM reset_streaks
        WHERE is_win=1
        GROUP BY reset_grp
        HAVING MAX(created_at) = (SELECT MAX(created_at) FROM reset_streaks)
      )
      SELECT MAX(current) AS streak FROM current_count;
    `;
    const r = this.db.prepare(sql).get(String(playerId));
    return r?.streak || 0;
  }

  /**
   * return all current streaks (optional limit)
   */
  all(limit = 100) {
    const sql = `
      WITH ordered AS (
        SELECT
          rc.player_id,
          COALESCE(r.display_name, rc.player_id) AS name,
          m.winner,
          CASE
            WHEN m.winner='BLUE' AND EXISTS (
              SELECT 1 FROM json_each(m.blue_ids) WHERE CAST(value AS TEXT) = rc.player_id
            ) THEN 1
            WHEN m.winner='RED' AND EXISTS (
              SELECT 1 FROM json_each(m.red_ids) WHERE CAST(value AS TEXT) = rc.player_id
            ) THEN 1
            ELSE 0
          END AS is_win,
          m.created_at
        FROM rating_changes rc
        JOIN matches m ON m.match_id = rc.match_id
        LEFT JOIN ratings r ON r.player_id = rc.player_id
        WHERE m.status='completed'
        ORDER BY rc.player_id, m.created_at ASC
      ),
      reset_streaks AS (
        SELECT
          player_id,
          name,
          SUM(CASE WHEN is_win=0 THEN 1 ELSE 0 END)
            OVER (PARTITION BY player_id ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          AS reset_grp,
          is_win,
          created_at
        FROM ordered
      ),
      current_count AS (
        SELECT player_id, name, COUNT(*) AS current
        FROM reset_streaks
        WHERE is_win=1
        GROUP BY player_id, name, reset_grp
        HAVING MAX(created_at) = (
          SELECT MAX(created_at) FROM reset_streaks r2 WHERE r2.player_id = reset_streaks.player_id
        )
      )
      SELECT player_id AS id, name, MAX(current) AS streak
      FROM current_count
      GROUP BY player_id, name
      ORDER BY streak DESC
      LIMIT ?;
    `;
    return this.db.prepare(sql).all(limit);
  }
}

module.exports = { WinStreakStore };
