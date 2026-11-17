"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { getPlayerLastGames } = require("../commands/matches");

test("player last games use website canonical MVPs instead of preserved round MVPs", () => {
  const db = new Database(":memory:");
  const playerId = "339782214562873344";
  const steamId = "STEAM_0:1:12345";
  const now = 1794924000;
  db.exec(`
    CREATE TABLE matches (
      match_id TEXT PRIMARY KEY, winner TEXT, created_at INTEGER,
      map_name TEXT, status TEXT, blue_ids TEXT, red_ids TEXT
    );
    CREATE TABLE rating_changes (match_id TEXT, player_id TEXT);
    CREATE TABLE player_steam_ids (discord_id TEXT, steam_id TEXT);
    CREATE TABLE match_round_mvps (match_id TEXT, mvp_player_key TEXT, steam_id TEXT);
    CREATE TABLE website_mvps (match_id TEXT, mvp_player_key TEXT, steam_id TEXT);
    CREATE VIEW canonical_match_mvps AS SELECT * FROM website_mvps;
  `);
  db.prepare("INSERT INTO player_steam_ids VALUES (?, ?)").run(playerId, steamId);
  const expected = ["win_mvp", "win", "win", "loss", "win_mvp", "tie", "loss", "win", "loss_mvp", "win"];
  expected.forEach((state, index) => {
    const matchId = `GAME_${index}`;
    const winner = state.startsWith("win") ? "blue" : state === "tie" ? "tie" : "red";
    db.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      matchId, winner, now - index, "map", "completed", JSON.stringify([playerId]), '["other"]'
    );
    db.prepare("INSERT INTO rating_changes VALUES (?, ?)").run(matchId, playerId);
    if (state.endsWith("_mvp")) {
      // Match either canonical identity field, normalizing Steam ID case.
      db.prepare("INSERT INTO website_mvps VALUES (?, ?, ?)").run(
        matchId, index === 0 ? steamId.toLowerCase() : "other", index === 0 ? null : steamId
      );
    }
  });
  // The preserved source disagrees: an old loss MVP must not override the website.
  db.prepare("INSERT INTO match_round_mvps VALUES (?, ?, ?)").run("GAME_6", steamId, steamId);
  // A game without a canonical MVP must not fall back to the old result.
  db.prepare("INSERT INTO match_round_mvps VALUES (?, ?, ?)").run("GAME_7", steamId, steamId);

  try {
    assert.deepEqual(getPlayerLastGames(db, playerId, now).map(game => game.state), expected);
  } finally {
    db.close();
  }
});

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

  const now = 5000000;
  const cutoff = now - 45 * 86400;
  db.prepare("UPDATE matches SET created_at = ? WHERE match_id = ?").run(now, "ROSTER_ONLY_LOSS");
  db.prepare("UPDATE matches SET created_at = ? WHERE match_id = ?").run(cutoff, "VALID_WIN");
  insertMatch.run("EXPIRED_WIN", "RED", cutoff - 1, "old_map", "completed", "[]", JSON.stringify([playerId]));
  db.prepare("INSERT INTO rating_changes VALUES (?, ?)").run("EXPIRED_WIN", playerId);

  try {
    const games = getPlayerLastGames(db, playerId, now);
    assert.deepEqual(games.map(game => game.match_id), ["VALID_WIN"]);
    assert.equal(games[0].state, "win");
    assert.deepEqual(getPlayerLastGames(db, playerId, now + 1), []);
  } finally {
    db.close();
  }
});
