"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { SteamLinks } = require("../lib/steamLinks");

function callbackDatabase(db) {
  return {
    all(sql, params, callback) {
      try { callback(null, db.prepare(sql).all(...params).map(row => ({ ...row }))); }
      catch (error) { callback(error); }
    },
    get(sql, params, callback) {
      try {
        const row = db.prepare(sql).get(...params);
        callback(null, row ? { ...row } : undefined);
      } catch (error) { callback(error); }
    },
    run(sql, params, callback) {
      try {
        const result = db.prepare(sql).run(...params);
        callback.call({ changes: Number(result.changes), lastID: Number(result.lastInsertRowid) }, null);
      } catch (error) { callback(error); }
    }
  };
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE player_steam_ids (
    discord_id TEXT NOT NULL, steam_id TEXT NOT NULL, display_name TEXT,
    PRIMARY KEY(discord_id, steam_id)
  )`);
  db.exec(`CREATE TABLE bootcamp_account_link_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, discord_id TEXT NOT NULL, steam_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(discord_id, steam_id)
  )`);
  return { db, links: new SteamLinks(":memory:", callbackDatabase(db)) };
}

test("SteamLinks claims account-sync work once, retries with bounded backoff, and completes it", async () => {
  const { db, links } = setup();
  try {
    db.prepare(`INSERT INTO bootcamp_account_link_outbox(discord_id,steam_id,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('discord-user','STEAM_0:1:4','pending',0,1000,1000,1000)`).run();
    const first = await links.claimBootcampAccountLinkSync(1000);
    assert.deepEqual(first, { id: 1, discord_id: "discord-user", steam_id: "STEAM_0:1:4", attempts: 1 });
    assert.equal(await links.claimBootcampAccountLinkSync(1001), null);

    await links.retryBootcampAccountLinkSync(1, 1, "ECONNRESET\nsecret", 1000);
    const retryRow = db.prepare("SELECT status, attempts, next_attempt_at, last_error FROM bootcamp_account_link_outbox WHERE id=1").get();
    assert.deepEqual({ ...retryRow }, { status: "pending", attempts: 1, next_attempt_at: 1015, last_error: "ECONNRESET_secret" });
    assert.equal(await links.claimBootcampAccountLinkSync(1014), null);
    const retry = await links.claimBootcampAccountLinkSync(1015);
    assert.equal(retry.attempts, 2);
    await links.completeBootcampAccountLinkSync(1, 1016);
    assert.equal(db.prepare("SELECT status FROM bootcamp_account_link_outbox WHERE id=1").get().status, "done");
    assert.equal(await links.claimBootcampAccountLinkSync(5000), null);
  } finally { links.close(); db.close(); }
});

test("stale in-progress account-sync work can be reclaimed after a Bot crash", async () => {
  const { db, links } = setup();
  try {
    db.prepare(`INSERT INTO bootcamp_account_link_outbox(discord_id,steam_id,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('discord-user','STEAM_0:1:4','processing',1,1000,800,800)`).run();
    assert.equal(await links.claimBootcampAccountLinkSync(919), null);
    const recovered = await links.claimBootcampAccountLinkSync(920);
    assert.equal(recovered.id, 1);
    assert.equal(recovered.attempts, 2);
  } finally { links.close(); db.close(); }
});

test("learning waitlist is persistent, idempotent, ordered, and excludes unlinked accounts", async () => {
  const { db, links } = setup();
  try {
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000001", "STEAM_0:1:4", "Runner A");
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000002", "STEAM_0:0:7", "Runner B");
    await links.joinBootcampLearningQueue("10000000000000001", "STEAM_0:1:4", 1000);
    await links.joinBootcampLearningQueue("10000000000000002", "STEAM_0:0:7", 1001);
    await links.joinBootcampLearningQueue("10000000000000001", "STEAM_0:1:4", 2000);
    const queue = await links.getBootcampLearningQueue();
    assert.deepEqual(queue.map(row => [row.discord_id, row.steam_id, row.display_name, row.joined_at]), [
      ["10000000000000001", "STEAM_0:1:4", "Runner A", 1000],
      ["10000000000000002", "STEAM_0:0:7", "Runner B", 1001],
    ]);
    await links.unlinkSteam("10000000000000001", "STEAM_0:1:4");
    assert.deepEqual((await links.getBootcampLearningQueue()).map(row => row.discord_id), ["10000000000000002"]);
  } finally { links.close(); db.close(); }
});

test("learning waitlist allows a player to remove their signup", async () => {
  const { db, links } = setup();
  try {
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000001", "STEAM_0:1:4", "Runner A");
    await links.joinBootcampLearningQueue("10000000000000001", "STEAM_0:1:4", 1000);
    assert.equal((await links.leaveBootcampLearningQueue("10000000000000001")).changes, 1);
    assert.deepEqual(await links.getBootcampLearningQueue(), []);
    assert.equal((await links.leaveBootcampLearningQueue("10000000000000001")).changes, 0);
  } finally { links.close(); db.close(); }
});

test("learning waitlist enforces its session size without dropping existing signups", async () => {
  const { db, links } = setup();
  try {
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000001", "STEAM_0:1:4", "Runner A");
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000002", "STEAM_0:0:7", "Runner B");
    assert.equal((await links.joinBootcampLearningQueue("10000000000000001", "STEAM_0:1:4", 1000, 1)).changes, 1);
    assert.equal((await links.joinBootcampLearningQueue("10000000000000002", "STEAM_0:0:7", 1001, 1)).changes, 0);
    assert.deepEqual((await links.getBootcampLearningQueue()).map(row => row.discord_id), ["10000000000000001"]);
  } finally { links.close(); db.close(); }
});

test("learning waitlist organizers can clear completed-session signups", async () => {
  const { db, links } = setup();
  try {
    db.prepare("INSERT INTO player_steam_ids(discord_id,steam_id,display_name) VALUES (?,?,?)")
      .run("10000000000000001", "STEAM_0:1:4", "Runner A");
    await links.joinBootcampLearningQueue("10000000000000001", "STEAM_0:1:4", 1000);
    assert.equal((await links.clearBootcampLearningQueue()).changes, 1);
    assert.deepEqual(await links.getBootcampLearningQueue(), []);
  } finally { links.close(); db.close(); }
});
