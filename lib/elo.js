// lib/elo.js
"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const { applyModeMultipliers } = require("./modeElo"); // 🔥 new import
const { rankFromRating } = require("./ranks");

/* ---------------------------- Config & Policies ---------------------------- */

const START_RATING = Number(process.env.ELO_START || 1941);
const MIN_RATING   = Number(process.env.ELO_MIN   || -1000);
const K_FACTOR     = Number(process.env.ELO_K     || 32);

/* --------------------------------- Helpers -------------------------------- */

const clampRating = (r) => Math.max(MIN_RATING, Math.round(Number(r) || 0));

// team-avg expectation (logistic)
function expectedScore(avgBlue, avgRed) {
  const diff = (Number(avgBlue) || 0) - (Number(avgRed) || 0);
  return 1 / (1 + Math.pow(10, -diff / 400));
}

/* --------------------------------- Class ---------------------------------- */

class EloDB {
  constructor(dbFile = "elo.db") {
    const full = path.resolve(process.cwd(), dbFile);
    this.db = new Database(full);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ratings (
        player_id    TEXT PRIMARY KEY,
        display_name TEXT,
        rating       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ratings_rating ON ratings(rating DESC);

      CREATE TABLE IF NOT EXISTS rating_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id   TEXT NOT NULL,
        ts         INTEGER,
        player_id  TEXT NOT NULL,
        before     INTEGER NOT NULL,
        after      INTEGER NOT NULL,
        delta      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_changes_match ON rating_changes(match_id);
      CREATE INDEX IF NOT EXISTS idx_changes_player_ts ON rating_changes(player_id, ts);
    `);

    const cols = this.db.prepare(`PRAGMA table_info(rating_changes)`).all();
    const hasTs = cols.some(c => String(c.name).toLowerCase() === "ts");
    if (!hasTs) {
      this.db.exec(`ALTER TABLE rating_changes ADD COLUMN ts INTEGER;`);
      const nowSec = Math.floor(Date.now() / 1000);
      this.db.exec(`UPDATE rating_changes SET ts = ${nowSec} WHERE ts IS NULL;`);
    }
  }

  _prepare() {
    this.selRating = this.db.prepare(`SELECT rating, display_name FROM ratings WHERE player_id = ?`);
    this.upsertRating = this.db.prepare(`
      INSERT INTO ratings (player_id, display_name, rating)
      VALUES (@player_id, COALESCE(NULLIF(@display_name,''), @player_id), @rating)
      ON CONFLICT(player_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name,''), ratings.display_name),
        rating       = excluded.rating
    `);
    this.updateRatingOnly = this.db.prepare(`UPDATE ratings SET rating = ? WHERE player_id = ?`);
    this.insertChange = this.db.prepare(`
      INSERT INTO rating_changes (match_id, ts, player_id, before, after, delta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.getChangesByMatch = this.db.prepare(`
      SELECT player_id, before, after, delta
      FROM rating_changes
      WHERE match_id = ?
      ORDER BY rowid DESC
    `);
    this.delChangesByMatch = this.db.prepare(`DELETE FROM rating_changes WHERE match_id = ?`);
    this.topStmt = this.db.prepare(`
      SELECT player_id, display_name, rating
      FROM ratings
      ORDER BY rating DESC
      LIMIT ?
    `);
    this.stHistory = this.db.prepare(`
      SELECT ts, before, after, delta, match_id
      FROM rating_changes
      WHERE player_id = ?
	    AND match_id NOT LIKE 'admin-%'
		AND match_id NOT LIKE 'seed-%'
      ORDER BY ts ASC
    `);
  }

  /* ------------------------------- Public API ------------------------------ */

  peekRating(playerId, defaultRating = START_RATING) {
    const id = String(playerId);
    try {
      const row = this.selRating.get(id);
      if (row && row.rating != null) return clampRating(row.rating);
    } catch {}
    return clampRating(defaultRating);
  }

  getRating(playerId, displayName = "", opts = {}) {
    const id = String(playerId);
    const row = this.selRating.get(id);
    if (row) return clampRating(row.rating);
    if (opts && opts.createIfMissing === false) return START_RATING;

    this.upsertRating.run({
      player_id: id,
      display_name: displayName || id,
      rating: START_RATING,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    this.insertChange.run(String(`seed-${id}`), nowSec, id, START_RATING, START_RATING, 0);
    return START_RATING;
  }

  getDisplayName(playerId, fallback = "") {
    const row = this.selRating.get(String(playerId));
    return row?.display_name || fallback || String(playerId);
  }

  getHistory(playerId) { return this.stHistory.all(String(playerId)); }

setRatingAdmin(playerId, rating, nickname = "") {
  const id = String(playerId);
  const after  = clampRating(rating);

  // Try to pull existing record (for before/after delta)
  const row = this.selRating.get(id);
  const before = row ? row.rating : after;
  const delta  = after - before;

  // Pick the best display name available
  const display_name = nickname && nickname.trim()
    ? nickname.trim()
    : (row?.display_name || id);

  // Always upsert both rating + display_name
  this.upsertRating.run({
    player_id: id,
    display_name,
    rating: after,
  });

  // Log the change
  const nowSec = Math.floor(Date.now() / 1000);
  this.insertChange.run(`admin-${Date.now()}`, nowSec, id, before, after, delta);

  return { id, before, after, delta };
}


  getTop(n = 10) { return this.topStmt.all(Math.max(1, Math.min(n, 100))); }

  _applyDelta(playerId, delta, matchId, displayName = "") {
    const id     = String(playerId);
    const before = this.getRating(id, displayName);
    const afterRaw  = before + Math.round(Number(delta) || 0);
    const after     = clampRating(afterRaw);
    const realDelta = after - before;

    this.updateRatingOnly.run(after, id);
    const ts = Math.floor(Date.now() / 1000);
    this.insertChange.run(String(matchId || `m-${Date.now()}`), ts, id, before, after, realDelta);
    return { id, before, after, delta: realDelta };
  }

  /**
   * Apply a team result.
   * args: { matchId, blue:[{id,name}], red:[{id,name}], winner:'blue'|'red'|'tie', createdAt?, match? }
   * opts: { kBlueOverride?: number, kRedOverride?: number }
   */
  applyTeamResult(args, opts = {}) {
    const { matchId, blue = [], red = [], winner, createdAt, match } = args || {};
    if (!matchId) throw new Error("Missing matchId");
    if (!["blue", "red", "tie"].includes(winner)) throw new Error("winner must be blue|red|tie");

    const ensure = (p) => this.getRating(p.id, p.name);
    const blueWithR = blue.map((p) => ({ ...p, before: ensure(p) }));
    const redWithR  = red .map((p) => ({ ...p, before: ensure(p) }));

    const avgVal = (arr) => Math.round(arr.reduce((a, x) => a + (x.before || 0), 0) / Math.max(1, arr.length));
    const avgBlue = avgVal(blueWithR);
    const avgRed  = avgVal(redWithR);

	// --- Dynamic odds-based scaling ---
	const expBlue = expectedScore(avgBlue, avgRed);
	const expRed  = 1 - expBlue;

	const scoreBlue = winner === "blue" ? 1 : (winner === "tie" ? 0.5 : 0);
	const scoreRed  = 1 - scoreBlue;

	// Base K-factor
	const kBaseBlue = Number.isFinite(opts.kBlueOverride) ? Number(opts.kBlueOverride) : K_FACTOR;
	const kBaseRed  = Number.isFinite(opts.kRedOverride)  ? Number(opts.kRedOverride)  : K_FACTOR;

	// 🧮 Dynamic scaling: underdogs get bigger swings
	const oddsFactorBlue = 1 + (0.5 - expBlue) * 2;  // favored = <1.0, underdog = >1.0
	const oddsFactorRed  = 1 + (0.5 - expRed)  * 2;

	const kBlue = kBaseBlue * oddsFactorBlue;
	const kRed  = kBaseRed  * oddsFactorRed;

	// Elo delta
	let dBlue = Math.round(kBlue * (scoreBlue - expBlue));
	let dRed  = Math.round(kRed  * (scoreRed  - expRed));

	if (!Number.isFinite(opts.kBlueOverride)) {
	  if (dBlue > 0) {
		dBlue = applyModeMultipliers(match, dBlue, {}); // winners boosted
	  }
	}
	if (!Number.isFinite(opts.kRedOverride)) {
	  if (dRed > 0) {
		dRed = applyModeMultipliers(match, dRed, {});   // winners boosted
	  }
	}
	
	// Cap the Elo swing to prevent runaway inflation
	const ELO_CAP = 35;
	if (dBlue > ELO_CAP) dBlue = ELO_CAP;
	if (dRed > ELO_CAP)  dRed  = ELO_CAP;
	if (dBlue < -ELO_CAP) dBlue = -ELO_CAP;
	if (dRed < -ELO_CAP)  dRed  = -ELO_CAP;

    const whenSec = Math.floor((createdAt ? Number(createdAt) : Date.now()) / 1000);

    // A live performance-based allocation must calculate the V1 team pools
    // without writing them first. The deferred live-gentle worker uses this
    // snapshot after NN scores arrive.
    if (opts.dryRun) {
      return {
        matchId: String(matchId),
        whenSec,
        avgBlue,
        avgRed,
        expBlue,
        expRed,
        kBlue,
        kRed,
        bluePool: dBlue,
        redPool: dRed,
        blue: blueWithR.map(p => ({ id: String(p.id), name: p.name || String(p.id), before: p.before })),
        red: redWithR.map(p => ({ id: String(p.id), name: p.name || String(p.id), before: p.before })),
      };
    }

    const tx = this.db.transaction(() => {
      const outBlue = [];
      const outRed  = [];

      for (const p of blueWithR) {
        const before = p.before;
        const after  = clampRating(before + dBlue);
        const real   = after - before;
        this.updateRatingOnly.run(after, String(p.id));
        this.insertChange.run(String(matchId), whenSec, String(p.id), before, after, real);
        outBlue.push({ id: String(p.id), name: p.name || String(p.id), before, after, delta: real, rank: rankFromRating(after) });
      }

      for (const p of redWithR) {
        const before = p.before;
        const after  = clampRating(before + dRed);
        const real   = after - before;
        this.updateRatingOnly.run(after, String(p.id));
        this.insertChange.run(String(matchId), whenSec, String(p.id), before, after, real);
        outRed.push({ id: String(p.id), name: p.name || String(p.id), before, after, delta: real, rank: rankFromRating(after) });
      }

      return { blue: outBlue, red: outRed, avgBlue, avgRed, expBlue, expRed, K: { blue: kBlue, red: kRed } };
    });

    return tx();
  }

  /**
   * Apply an already-calculated team result using exact per-player deltas.
   * Every player's current rating must still equal the recorded `before`
   * value; this prevents a delayed live allocation from overwriting a later
   * match or admin adjustment.
   */
  applyPreparedTeamResult(prepared, allocations, matchId = prepared?.matchId) {
    if (!prepared?.blue?.length || !prepared?.red?.length) throw new Error("Missing prepared team result");
    const all = [...prepared.blue, ...prepared.red];
    const deltaById = new Map((allocations || []).map(row => [String(row.id), Number(row.delta)]));
    if (all.some(player => !deltaById.has(String(player.id)))) throw new Error("Incomplete prepared Elo allocation");

    const tx = this.db.transaction(() => {
      const output = { blue: [], red: [] };
      for (const [team, players] of [["blue", prepared.blue], ["red", prepared.red]]) {
        for (const player of players) {
          const id = String(player.id);
          const current = this.peekRating(id);
          const expected = clampRating(player.before);
          if (current !== expected) {
            throw new Error(`live_elo_rating_changed:${id}:${expected}:${current}`);
          }
          const after = clampRating(expected + Math.round(deltaById.get(id) || 0));
          const realDelta = after - expected;
          this.updateRatingOnly.run(after, id);
          this.insertChange.run(String(matchId), prepared.whenSec || Math.floor(Date.now() / 1000), id, expected, after, realDelta);
          output[team].push({
            id,
            name: player.name || id,
            before: expected,
            after,
            delta: realDelta,
            rank: rankFromRating(after),
          });
        }
      }
      return { ...output, avgBlue: prepared.avgBlue, avgRed: prepared.avgRed, expBlue: prepared.expBlue, expRed: prepared.expRed };
    });
    return tx();
  }

  recordMatch(blueIds, redIds, result, opts = {}) {
    const matchId = opts.matchId || `M-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const names   = opts.displayNames || null;
    const match   = opts.match || null;

    const getName = (id) => (names
      ? (names instanceof Map ? names.get(String(id)) : names[String(id)])
      : null);

    const blueWith = blueIds.map(id => ({ id: String(id), name: getName(id), before: this.getRating(id, getName(id)) }));
    const redWith  = redIds .map(id => ({ id: String(id), name: getName(id), before: this.getRating(id, getName(id)) }));

    const avgVal = (arr) => Math.round(arr.reduce((a, x) => a + (x.before || 0), 0) / Math.max(1, arr.length));
    const avgBlue = avgVal(blueWith);
    const avgRed  = avgVal(redWith);

	const expBlue = expectedScore(avgBlue, avgRed);
	const expRed  = 1 - expBlue;

	let sBlue = 0.5, sRed = 0.5;
	if (result === "blue") { sBlue = 1; sRed = 0; }
	if (result === "red")  { sBlue = 0; sRed = 1; }

	// Base K
	const kBaseBlue = Number.isFinite(opts.kBlueOverride) ? Number(opts.kBlueOverride) : K_FACTOR;
	const kBaseRed  = Number.isFinite(opts.kRedOverride)  ? Number(opts.kRedOverride)  : K_FACTOR;

	// Dynamic scaling
	const oddsFactorBlue = 1 + (0.5 - expBlue) * 2;
	const oddsFactorRed  = 1 + (0.5 - expRed)  * 2;

	const kBlue = kBaseBlue * oddsFactorBlue;
	const kRed  = kBaseRed  * oddsFactorRed;

	// Elo deltas
	let dBlue = Math.round(kBlue * (sBlue - expBlue));
	let dRed  = Math.round(kRed  * (sRed  - expRed));

	if (!Number.isFinite(opts.kBlueOverride)) {
	  if (dBlue > 0) {
		dBlue = applyModeMultipliers(match, dBlue, {}); // winners boosted
	  }
	}
	if (!Number.isFinite(opts.kRedOverride)) {
	  if (dRed > 0) {
		dRed = applyModeMultipliers(match, dRed, {});   // winners boosted
	  }
	}

	// 🧩 CAP DELTAS HERE
	const ELO_CAP = 35 * (1 + Math.abs(0.5 - expBlue)); // slightly higher cap for bigger upsets
	if (dBlue > ELO_CAP) dBlue = ELO_CAP;
	if (dRed > ELO_CAP)  dRed  = ELO_CAP;
	if (dBlue < -ELO_CAP) dBlue = -ELO_CAP;
	if (dRed < -ELO_CAP)  dRed  = -ELO_CAP;

    const tx = this.db.transaction(() => {
      const outBlue = [];
      const outRed  = [];
      const ts = Math.floor(Date.now() / 1000);

      for (const p of blueWith) {
        const after = clampRating(p.before + dBlue);
        const realDelta = after - p.before;
        this.updateRatingOnly.run(after, p.id);
        this.insertChange.run(String(matchId), ts, p.id, p.before, after, realDelta);
        outBlue.push({ id: p.id, name: p.name || p.id, before: p.before, after, delta: realDelta });
      }
      for (const p of redWith) {
        const after = clampRating(p.before + dRed);
        const realDelta = after - p.before;
        this.updateRatingOnly.run(after, p.id);
        this.insertChange.run(String(matchId), ts, p.id, p.before, after, realDelta);
        outRed.push({ id: p.id, name: p.name || p.id, before: p.before, after, delta: realDelta });
      }

      return { blue: outBlue, red: outRed, avgBlue, avgRed, expBlue, expRed };
    });

    return { matchId, ...tx() };
  }

  unreportMatch(matchId) {
    const mid = String(matchId);
    const changes = this.getChangesByMatch.all(mid);
    if (!changes.length) throw new Error("No rating changes found for that match.");

    const tx = this.db.transaction(() => {
      let count = 0;
      for (const ch of changes) {
        this.updateRatingOnly.run(ch.before, String(ch.player_id));
        count++;
      }
      this.delChangesByMatch.run(mid);
      return { revertedCount: count };
    });

    return tx();
  }

  deleteMatch(matchId) {
    const mid = String(matchId);
    try {
      const tx = this.db.transaction(() => {
        this.db.prepare("DELETE FROM rating_changes WHERE match_id=?").run(mid);
        //this.db.prepare("DELETE FROM match_meta WHERE match_id=?").run(mid);
      });
      tx();
      return { ok: true, matchId: mid };
    } catch (e) {
      console.error("[elo.deleteMatch] failed:", e);
      return { ok: false, error: e.message };
    }
  }

  getBatchRatings(ids, displayNames = null) {
    const out = [];
    for (const id of ids) {
      const name = displayNames
        ? (displayNames instanceof Map ? displayNames.get(String(id)) : displayNames[String(id)])
        : null;
      out.push(this.getRating(id, name));
    }
    return out;
  }

  bump(playerId, delta, matchId = null, displayName = null) {
    return this._applyDelta(playerId, delta, matchId, displayName);
  }

  setDisplayName(playerId, displayName) {
    const id = String(playerId);
    const row = this.selRating.get(id);
    if (!row) {
      this.upsertRating.run({ player_id: id, display_name: displayName || id, rating: START_RATING });
      const nowSec = Math.floor(Date.now() / 1000);
      this.insertChange.run(String(`seed-${id}`), nowSec, id, START_RATING, START_RATING, 0);
      return { id, rating: START_RATING };
    }
    this.upsertRating.run({ player_id: id, display_name: displayName || id, rating: row.rating });
    return { id, rating: clampRating(row.rating) };
  }
  /* --------------------------- Streak Extensions -------------------------- */

  /**
   * Get a player's current win/loss streak.
   * Positive = consecutive wins, negative = consecutive losses.
   */
  getCurrentStreak(playerId) {
    const hist = this.getHistory(playerId);
    if (!hist || hist.length === 0) return 0;

    let streak = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      if (!h) continue;
      if (h.delta > 0) {
        if (streak >= 0) streak++;
        else break;
      } else if (h.delta < 0) {
        if (streak <= 0) streak--;
        else break;
      } else {
        break;
      }
    }
    return streak;
  }

  /**
   * Convert streak length into an Elo multiplier.
   * Example policy: 3+ wins = 1.5x, 5+ wins = 2x.
   */
  getStreakMultiplier(playerId) {
    const streak = this.getCurrentStreak(playerId);
    if (streak >= 5) return 2.0;
    if (streak >= 3) return 1.5;
    return 1.0;
  }
}

/* -------------------------------- Exports --------------------------------- */

module.exports = new EloDB("elo.db");   // default instance
module.exports.EloDB = EloDB;
module.exports.rankFromRating = rankFromRating;
module.exports.START_RATING = START_RATING;
module.exports.MIN_RATING   = MIN_RATING;
module.exports.K_FACTOR     = K_FACTOR;
