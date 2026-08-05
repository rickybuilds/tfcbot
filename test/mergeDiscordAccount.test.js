"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  chooseRatingWinner,
  runMerge,
} = require("../tools/mergeDiscordAccount");

const OLD_ID = "389593841390583809";
const NEW_ID = "1534624155838976234";

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfcbot-account-merge-"));
  const eloPath = path.join(dir, "elo.db");
  const botPath = path.join(dir, "bot.db");
  const db = new Database(eloPath);
  db.exec(`
    CREATE TABLE ratings (player_id TEXT PRIMARY KEY, display_name TEXT, rating INTEGER NOT NULL);
    CREATE TABLE rating_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, player_id TEXT NOT NULL,
      before INTEGER, after INTEGER, delta INTEGER, ts INTEGER,
      UNIQUE(match_id, player_id)
    );
    CREATE TABLE match_players (
      match_id TEXT, player_id TEXT, team TEXT, created_at INTEGER,
      map_name TEXT, status TEXT, winner TEXT, PRIMARY KEY(match_id, player_id)
    );
    CREATE TABLE matches (
      match_id TEXT PRIMARY KEY, blue_ids TEXT, red_ids TEXT, bonus_elo TEXT,
      shuffle_history TEXT, team_scenarios TEXT
    );
    CREATE TABLE player_steam_ids (
      discord_id TEXT, steam_id TEXT, display_name TEXT, is_primary INTEGER,
      notes TEXT, created_at INTEGER, updated_at INTEGER,
      PRIMARY KEY(discord_id, steam_id)
    );
    CREATE TABLE player_identities (steam_id TEXT PRIMARY KEY, discord_id TEXT);
    CREATE TABLE discord_names (
      discord_id TEXT PRIMARY KEY, username TEXT, global_name TEXT, display_name TEXT
    );
    CREATE TABLE user_prefs (player_id TEXT PRIMARY KEY, hide_elo INTEGER NOT NULL);
    CREATE TABLE pickup_mutes (
      discord_id TEXT PRIMARY KEY, muted_by TEXT, reason TEXT, created_at INTEGER, guild_id TEXT
    );
    CREATE TABLE match_player_stats (
      match_id TEXT, player_key TEXT, kills INTEGER, PRIMARY KEY(match_id, player_key)
    );
    CREATE TABLE one_v_one_challenges (
      challenge_id TEXT PRIMARY KEY, challenger_discord_id TEXT, challenged_discord_id TEXT
    );
    CREATE TABLE web_analytics (id INTEGER PRIMARY KEY, path TEXT);
  `);
  db.prepare("INSERT INTO ratings VALUES (?,?,?)").run(OLD_ID, "Old Name", 2222);
  db.prepare("INSERT INTO ratings VALUES (?,?,?)").run(NEW_ID, "New Name", 1941);
  db.prepare("INSERT INTO rating_changes(match_id,player_id,before,after,delta,ts) VALUES (?,?,?,?,?,?)")
    .run(`seed-${OLD_ID}`, OLD_ID, 1941, 1941, 0, 1);
  db.prepare("INSERT INTO rating_changes(match_id,player_id,before,after,delta,ts) VALUES (?,?,?,?,?,?)")
    .run("MATCH1", OLD_ID, 2200, 2222, 22, 2);
  db.prepare("INSERT INTO rating_changes(match_id,player_id,before,after,delta,ts) VALUES (?,?,?,?,?,?)")
    .run(`seed-${NEW_ID}`, NEW_ID, 1941, 1941, 0, 3);
  db.prepare("INSERT INTO match_players VALUES (?,?,?,?,?,?,?)")
    .run("MATCH1", OLD_ID, "blue", 1, "2fort", "completed", "blue");
  db.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?)").run(
    "MATCH1",
    JSON.stringify([OLD_ID, "other"]),
    JSON.stringify([]),
    JSON.stringify({ [OLD_ID]: 22 }),
    JSON.stringify([{ players: [OLD_ID] }]),
    JSON.stringify({ captain: OLD_ID })
  );
  db.prepare("INSERT INTO player_steam_ids VALUES (?,?,?,?,?,?,?)")
    .run(OLD_ID, "STEAM_0:1:1", "Old Name", 1, "source", 10, 20);
  db.prepare("INSERT INTO player_steam_ids VALUES (?,?,?,?,?,?,?)")
    .run(NEW_ID, "STEAM_0:1:1", "New Name", 0, null, 11, 19);
  db.prepare("INSERT INTO player_identities VALUES (?,?)").run("STEAM_0:1:1", OLD_ID);
  db.prepare("INSERT INTO discord_names VALUES (?,?,?,?)")
    .run(OLD_ID, "old", "Old Global", "Old Display");
  db.prepare("INSERT INTO discord_names VALUES (?,?,?,?)")
    .run(NEW_ID, "new", null, null);
  db.prepare("INSERT INTO user_prefs VALUES (?,?)").run(OLD_ID, 1);
  db.prepare("INSERT INTO user_prefs VALUES (?,?)").run(NEW_ID, 0);
  db.prepare("INSERT INTO pickup_mutes VALUES (?,?,?,?,?)")
    .run("someone", OLD_ID, "reason", 1, "guild");
  db.prepare("INSERT INTO match_player_stats VALUES (?,?,?)").run("MATCH1", OLD_ID, 10);
  db.prepare("INSERT INTO one_v_one_challenges VALUES (?,?,?)").run("C1", OLD_ID, "someone");
  db.prepare("INSERT INTO web_analytics VALUES (?,?)").run(1, `/api/player/${OLD_ID}`);
  db.close();

  const bot = new Database(botPath);
  bot.exec(`
    CREATE TABLE game_bans (
      user_id TEXT PRIMARY KEY, games_remaining INTEGER, reason TEXT, banned_at INTEGER
    );
    CREATE TABLE temp_bans (user_id TEXT PRIMARY KEY, expires_at INTEGER);
  `);
  bot.prepare("INSERT INTO game_bans VALUES (?,?,?,?)").run(OLD_ID, 3, "old ban", 20);
  bot.prepare("INSERT INTO game_bans VALUES (?,?,?,?)").run(NEW_ID, 1, "new ban", 10);
  bot.prepare("INSERT INTO temp_bans VALUES (?,?)").run(OLD_ID, 100);
  bot.prepare("INSERT INTO temp_bans VALUES (?,?)").run(NEW_ID, 200);
  bot.close();

  return { dir, eloPath, botPath };
}

function options(extra = {}) {
  return {
    oldId: OLD_ID,
    newId: NEW_ID,
    dryRun: false,
    keepOldRating: false,
    keepNewRating: false,
    ...extra,
  };
}

function quietly(fn) {
  const original = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = original; }
}

test("dry run executes the complete merge and rolls it back", t => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const result = quietly(() => runMerge(
    options({ dryRun: true }),
    { eloPath: fixture.eloPath, botPath: fixture.botPath }
  ));
  assert.equal(result.ratingWinner, "old");
  assert.equal(result.verification.unexpected.length, 0);

  const db = new Database(fixture.eloPath, { readonly: true });
  assert.equal(db.prepare("SELECT rating FROM ratings WHERE player_id=?").get(OLD_ID).rating, 2222);
  assert.equal(db.prepare("SELECT rating FROM ratings WHERE player_id=?").get(NEW_ID).rating, 1941);
  db.close();
});

test("merge preserves the selected rating and all source history", t => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const result = quietly(() => runMerge(
    options(),
    { eloPath: fixture.eloPath, botPath: fixture.botPath }
  ));
  assert.equal(result.ratingWinner, "old");
  assert.equal(result.report.ratings.history, 2);
  assert.equal(result.verification.expected.length, 2);
  assert.equal(result.verification.unexpected.length, 0);

  const db = new Database(fixture.eloPath, { readonly: true });
  assert.deepEqual(
    db.prepare("SELECT display_name, rating FROM ratings WHERE player_id=?").get(NEW_ID),
    { display_name: "Old Name", rating: 2222 }
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE player_id=?").get(OLD_ID).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rating_changes WHERE player_id=?").get(NEW_ID).n, 3);
  assert.deepEqual(JSON.parse(db.prepare("SELECT blue_ids FROM matches").get().blue_ids), [NEW_ID, "other"]);
  assert.equal(db.prepare("SELECT discord_id FROM player_identities").get().discord_id, NEW_ID);
  assert.equal(db.prepare("SELECT is_primary FROM player_steam_ids").get().is_primary, 1);
  assert.equal(db.prepare("SELECT hide_elo FROM user_prefs WHERE player_id=?").get(NEW_ID).hide_elo, 1);
  assert.equal(db.prepare("SELECT muted_by FROM pickup_mutes").get().muted_by, NEW_ID);
  db.close();

  const bot = new Database(fixture.botPath, { readonly: true });
  assert.deepEqual(bot.prepare("SELECT games_remaining, reason FROM game_bans WHERE user_id=?").get(NEW_ID), {
    games_remaining: 3,
    reason: "old ban",
  });
  assert.equal(bot.prepare("SELECT expires_at FROM temp_bans WHERE user_id=?").get(NEW_ID).expires_at, 200);
  bot.close();
});

test("two legitimate ratings require an explicit administrator choice", () => {
  const accounts = {
    old: { rating: { rating: 2200 } },
    new: { rating: { rating: 2300 } },
  };
  assert.throws(
    () => chooseRatingWinner(accounts, options()),
    /--keep-old-rating or --keep-new-rating/
  );
  assert.equal(chooseRatingWinner(accounts, options({ keepNewRating: true })), "new");
});

test("conflicting UNIQUE history rows abort and roll back", t => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const db = new Database(fixture.eloPath);
  db.prepare("INSERT INTO rating_changes(match_id,player_id,before,after,delta,ts) VALUES (?,?,?,?,?,?)")
    .run("MATCH1", NEW_ID, 1900, 1910, 10, 2);
  db.close();

  assert.throws(
    () => quietly(() => runMerge(
      options(),
      { eloPath: fixture.eloPath, botPath: fixture.botPath }
    )),
    /Conflicting rating_changes rows would collide/
  );

  const check = new Database(fixture.eloPath, { readonly: true });
  assert.equal(check.prepare("SELECT rating FROM ratings WHERE player_id=?").get(OLD_ID).rating, 2222);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM rating_changes WHERE player_id=?").get(OLD_ID).n, 2);
  check.close();
});
