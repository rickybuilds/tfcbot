"use strict";

function challengesEnabled(env = process.env) {
  return String(env.BOOTCAMP_CHALLENGES_ENABLED || "").trim().toLowerCase() === "true";
}

async function currentChallenge(pool) {
  const [rows] = await pool.query(`
    SELECT c.id, DATE_FORMAT(c.starts_at, '%Y-%m-%d') AS week_start, COALESCE(r.map, d.map) AS map,
           c.target_type, c.target_id, c.title, c.starts_at, c.ends_at,
           COALESCE(r.name, d.name) AS target_name
      FROM bootcamp_challenges c
      LEFT JOIN bootcamp_routes r ON c.target_type = 'route' AND r.id = c.target_id AND r.enabled = 1
      LEFT JOIN bootcamp_drills d ON c.target_type = 'drill' AND d.id = c.target_id AND d.enabled = 1
     WHERE c.starts_at <= UTC_TIMESTAMP() AND c.ends_at > UTC_TIMESTAMP()
       AND ((c.target_type = 'route' AND r.id IS NOT NULL) OR (c.target_type = 'drill' AND d.id IS NOT NULL))
     ORDER BY c.starts_at DESC, c.id DESC LIMIT 1
  `);
  return rows[0] || null;
}

async function challengeStandings(pool, challenge, limit = 10) {
  if (challenge.target_type === "route") {
    const [rows] = await pool.query(`
      SELECT steamid, player_name, class_id, time_ms AS result, run_id AS result_id FROM (
        SELECT b.steamid, b.player_name, b.class_id, b.time_ms, b.id AS run_id,
               ROW_NUMBER() OVER (PARTITION BY b.steamid, b.class_id ORDER BY b.time_ms, b.id) AS player_rank
          FROM bootcamp_runs b
          JOIN bootcamp_routes r ON r.id = b.route_id AND r.map = b.map AND r.config_version = b.config_version AND r.enabled = 1
         WHERE b.route_id = ? AND b.created_at >= ? AND b.created_at < ? AND b.valid = 1 AND b.mode = 1
           AND b.finalization_required = 0 AND (b.flagged = 0 OR b.reviewed = 1)
      ) ranked WHERE player_rank = 1 ORDER BY result, result_id LIMIT ?
    `, [challenge.target_id, challenge.starts_at, challenge.ends_at, limit]);
    return rows;
  }
  if (challenge.target_type === "drill") {
    const [rows] = await pool.query(`
      SELECT steamid, player_name, class_id, score AS result, set_id AS result_id FROM (
        SELECT s.steamid, s.player_name, s.class_id, s.score, s.id AS set_id,
               ROW_NUMBER() OVER (PARTITION BY s.steamid, s.class_id ORDER BY s.score DESC, s.id) AS player_rank
          FROM bootcamp_drill_sets s JOIN bootcamp_drills d ON d.id = s.drill_id AND d.map = s.map AND d.enabled = 1
         WHERE s.drill_id = ? AND s.created_at >= ? AND s.created_at < ? AND s.finalization_required = 0
           AND (s.recording_token IS NULL OR EXISTS (
             SELECT 1 FROM bootcamp_finalized_drill_sets f
             JOIN bootcamp_ghosts g ON g.id = s.ghost_id AND g.drill_set_id = s.id AND g.is_complete = 1
                  AND g.pos_frames >= 2 AND g.map = s.map AND g.steamid = s.steamid AND g.class_id = s.class_id
             WHERE f.drill_set_id = s.id AND EXISTS (
               SELECT 1 FROM bootcamp_ghost_chunks c WHERE c.ghost_id = g.id AND c.track = 'pos' AND c.chunk_id = 0
             )
           ))
      ) ranked WHERE player_rank = 1 ORDER BY result DESC, result_id LIMIT ?
    `, [challenge.target_id, challenge.starts_at, challenge.ends_at, limit]);
    return rows;
  }
  throw new Error("Unsupported Bootcamp challenge target");
}

module.exports = { challengesEnabled, currentChallenge, challengeStandings };
