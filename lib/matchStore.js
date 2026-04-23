// lib/matchStore.js
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

class MatchStore {
  constructor(dbFile = "/root/tfcbot/elo.db") {
    console.log("[MatchStore] Opening database:", dbFile);
    this.db = new Database(dbFile);
    this.init();
  }

  init() {
    // Deletes must target the base tables, not the view
    this.delMatch        = this.db.prepare(`DELETE FROM matches WHERE match_id=?`);
    this.delRatingChange = this.db.prepare(`DELETE FROM rating_changes WHERE match_id=?`);

    // Inserts also target base table
    this.insertMatch = this.db.prepare(`
      INSERT INTO matches (match_id, created_at, map_name, server_name, blue_ids, red_ids, winner, processed_at, status)
      VALUES (@match_id, @created_at, @map_name, @server_name, @blue_ids, @red_ids, @winner, @processed_at, @status)
      ON CONFLICT(match_id) DO UPDATE SET
        map_name     = excluded.map_name,
        server_name  = excluded.server_name,
        blue_ids     = excluded.blue_ids,
        red_ids      = excluded.red_ids,
        winner       = excluded.winner,
        processed_at = excluded.processed_at,
        status       = excluded.status;
    `);

    this.insertRatingChange = this.db.prepare(`
      INSERT INTO rating_changes (match_id, player_id, before, after, delta, created_at, ts)
      VALUES (@match_id, @player_id, @before, @after, @delta, @created_at, @ts)
    `);

    // Reads can safely use the view
    this.getByIdStmt   = this.db.prepare(`SELECT * FROM match_results WHERE match_id=?`);
    this.getRecentStmt = this.db.prepare(`SELECT * FROM match_results ORDER BY created_at DESC LIMIT ?`);
    this.markProcessedStmt = this.db.prepare(`UPDATE matches SET processed_at=? WHERE match_id=?`);
  }

  reload() { /* nothing needed */ }

  saveMatch(m) {
    const row = {
      match_id: m.id,
      created_at: Math.floor((m.createdAt || Date.now()) / 1000),
      map_name: m.map || null,
      server_name: m.server?.name || null,
      blue_ids: JSON.stringify((m.blueTeam || []).map(p => String(p.id))),
      red_ids: JSON.stringify((m.redTeam || []).map(p => String(p.id))),
      winner: m.winner || null,
      processed_at: m.reported ? Math.floor(Date.now() / 1000) : null,
      status: m.status || "completed"
    };

    const tx = this.db.transaction(() => {
      this.insertMatch.run(row);
      if (m.ratingChanges) {
        for (const rc of m.ratingChanges) {
          this.insertRatingChange.run({
            match_id: m.id,
            player_id: String(rc.playerId),
            before: rc.before,
            after: rc.after,
            delta: rc.delta,
            created_at: Math.floor(Date.now() / 1000),
            ts: Date.now(),
          });
        }
      }
    });
    tx();
  }

deleteById(matchId) {
  const tx = this.db.transaction((mid) => {
    this.delRatingChange.run(mid);
    const r = this.delMatch.run(mid); // deletes from matches (base table)
    return r.changes > 0;
  });
  return tx(String(matchId));
}


  deleteMatch(matchId) { return this.deleteById(matchId); }

  markReported(matchId, maybeFlag) {
    const ts = (typeof maybeFlag === "boolean")
      ? (maybeFlag ? Math.floor(Date.now() / 1000) : null)
      : Math.floor(Date.now() / 1000);
    this.markProcessedStmt.run(ts, String(matchId));
  }

  findById(id) {
    const r = this.getByIdStmt.get(String(id));
    if (!r) return null;

    let blue = [], red = [];
    try { blue = JSON.parse(r.blue_ids || "[]"); } catch {}
    try { red  = JSON.parse(r.red_ids || "[]"); } catch {}

    return {
      id: r.match_id,
      createdAt: r.created_at * 1000,
      server: { name: r.server_name },
      map: r.map_name,
      blueTeam: blue.map(id => ({ id, name: id })),
      redTeam:  red.map(id => ({ id, name: id })),
      reported: !!r.processed_at,
      winner: r.winner,
    };
  }

  getRecent(n = 10) {
    const rows = this.getRecentStmt.all(Math.max(1, Math.min(n, 50)));
    return rows.map(r => {
      let blue = [], red = [];
      try { blue = JSON.parse(r.blue_ids || "[]"); } catch {}
      try { red  = JSON.parse(r.red_ids || "[]"); } catch {}
      return {
        id: r.match_id,
        createdAt: r.created_at * 1000,
        server: { name: r.server_name },
        map: r.map_name,
        blueTeam: blue.map(id => ({ id, name: id })),
        redTeam:  red.map(id => ({ id, name: id })),
        reported: !!r.processed_at,
        winner: r.winner,
      };
    });
  }

  update(updater) {
    const all = this.getRecent(5000);
    const out = [];
    for (const m of all) {
      const r = updater(m);
      if (r && typeof r === "object") out.push(r);
    }

    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM rating_changes; DELETE FROM matches;`);
      for (const m of out) this.saveMatch(m);
    });
    tx();
  }
}

module.exports = { MatchStore };