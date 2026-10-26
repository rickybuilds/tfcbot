"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { getPlayerLastGames } = require("../commands/matches");

test("player last games ignore completed roster-only matches", () => {
  const db = new Database(":memory:");
  const playerId = "183763294996135936";
  db.exec(`
    CREATE TABLE matches (
      match_id TEXT PRIMARY KEY,
      winner TEXT,
      created_at INTEGER,
      map_name TEXT,
      status TEXT,
      blue_ids TEXT,
      red_ids TEXT
    );
    CREATE TABLE rating_changes (
      match_id TEXT,
      player_id TEXT
    );
    CREATE TABLE player_steam_ids (
      discord_id TEXT,
      steam_id TEXT
    );
  `);

  const insertMatch = db.prepare(
    "INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  insertMatch.run(
    "ROSTER_ONLY_LOSS",
    "BLUE",
    200,
    "stale_map",
    "completed",
    JSON.stringify(["other"]),
    JSON.stringify([playerId])
  );
  insertMatch.run(
    "VALID_WIN",
    "RED",
    100,
    "valid_map",
    "completed",
    JSON.stringify(["other"]),
    JSON.stringify([playerId])
  );
  db.prepare("INSERT INTO rating_changes VALUES (?, ?)").run("VALID_WIN", playerId);

  try {
    const games = getPlayerLastGames(db, playerId);
    assert.deepEqual(games.map(game => game.match_id), ["VALID_WIN"]);
    assert.equal(games[0].state, "win");
  } finally {
    db.close();
  }
});
