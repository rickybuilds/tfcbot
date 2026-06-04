const Database = require("better-sqlite3");
const db = new Database("/root/tfcbot/elo.db");

const rows = db.prepare(`
  SELECT match_id, created_at, map_name, status, winner, blue_ids, red_ids
  FROM matches
`).all();

const insert = db.prepare(`
  INSERT OR REPLACE INTO match_players
  (match_id, player_id, team, created_at, map_name, status, winner)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction((matches) => {
  for (const m of matches) {
    let blue = [];
    let red = [];

    try { blue = JSON.parse(m.blue_ids || "[]"); } catch {}
    try { red = JSON.parse(m.red_ids || "[]"); } catch {}

    for (const pid of blue) {
      insert.run(
        m.match_id,
        String(pid),
        "BLUE",
        m.created_at,
        m.map_name || null,
        m.status || null,
        m.winner || null
      );
    }

    for (const pid of red) {
      insert.run(
        m.match_id,
        String(pid),
        "RED",
        m.created_at,
        m.map_name || null,
        m.status || null,
        m.winner || null
      );
    }
  }
});

tx(rows);

const count = db.prepare(`SELECT COUNT(*) AS c FROM match_players`).get();
console.log(`Done. match_players rows: ${count.c}`);

