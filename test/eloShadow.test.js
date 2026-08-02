"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  EloShadowService,
  calculateShadow,
  formatShadowMessage,
} = require("../services/eloShadow");

function player(id, score, team, currentDelta) {
  return {
    id,
    name: id,
    team,
    before: 2000,
    currentDelta,
    score,
  };
}

test("performance redistributes but conserves the exact V1 team totals", () => {
  const snapshot = calculateShadow({
    matchId: "SHADOW1",
    winner: "blue",
    formulaVersion: "nn-mvp-v1",
    apiPlayerCount: 8,
    blue: [
      player("b1", 140, "BLUE", 20),
      player("b2", 80, "BLUE", 20),
      player("b3", 20, "BLUE", 20),
      player("b4", -40, "BLUE", 20),
    ],
    red: [
      player("r1", 140, "RED", -20),
      player("r2", 80, "RED", -20),
      player("r3", 20, "RED", -20),
      player("r4", -40, "RED", -20),
    ],
  }, { alpha: 0.35, minimumShare: 0.15, maximumShare: 0.35 });

  assert.deepEqual(snapshot.pools, { blue: 80, red: -80 });
  assert.equal(snapshot.poolSource, "v1-team-totals");
  assert.equal(snapshot.teams.blue.reduce((sum, p) => sum + p.shadowDelta, 0), 80);
  assert.equal(snapshot.teams.red.reduce((sum, p) => sum + p.shadowDelta, 0), -80);
  assert.ok(snapshot.teams.blue[0].shadowDelta > snapshot.teams.blue[3].shadowDelta);
  assert.ok(Math.abs(snapshot.teams.red[0].shadowDelta) < Math.abs(snapshot.teams.red[3].shadowDelta));
  assert.ok(snapshot.teams.blue.every(p => p.share >= 0.15 - 1e-9 && p.share <= 0.35 + 1e-9));
  assert.ok(snapshot.teams.red.every(p => p.share >= 0.15 - 1e-9 && p.share <= 0.35 + 1e-9));
  assert.equal(snapshot.scenarios.gentle.teams.blue.reduce((sum, p) => sum + p.shadowDelta, 0), 80);
  assert.equal(snapshot.scenarios.gentle.teams.red.reduce((sum, p) => sum + p.shadowDelta, 0), -80);
  assert.ok(snapshot.scenarios.gentle.teams.blue.every(p => p.share >= 0.20 - 1e-9 && p.share <= 0.30 + 1e-9));
  assert.ok(snapshot.scenarios.gentle.teams.red.every(p => p.share >= 0.20 - 1e-9 && p.share <= 0.30 + 1e-9));
});

test("fallback gives every official player an equal share", () => {
  const snapshot = calculateShadow({
    matchId: "SHADOW2",
    winner: "red",
    fallbackReason: "performance_rows_9",
    apiPlayerCount: 9,
    blue: [1, 2, 3, 4].map(id => player(`b${id}`, 100 - id, "BLUE", -20)),
    red: [1, 2, 3, 4].map(id => player(`r${id}`, 100 - id, "RED", 20)),
  });

  assert.deepEqual(snapshot.teams.blue.map(p => p.shadowDelta), [-20, -20, -20, -20]);
  assert.deepEqual(snapshot.teams.red.map(p => p.shadowDelta), [20, 20, 20, 20]);
  assert.deepEqual(snapshot.scenarios.gentle.teams.blue.map(p => p.shadowDelta), [-20, -20, -20, -20]);
  assert.deepEqual(snapshot.scenarios.gentle.teams.red.map(p => p.shadowDelta), [20, 20, 20, 20]);
  assert.match(formatShadowMessage(snapshot), /equal-share fallback/);
  assert.match(formatShadowMessage(snapshot), /no live Elo changed/);
});

function serviceHarness(apiPlayers) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE matches (
      match_id TEXT PRIMARY KEY, winner TEXT, status TEXT, blue_ids TEXT, red_ids TEXT,
      mode TEXT, rng_multiplier REAL
    );
    CREATE TABLE ratings (player_id TEXT PRIMARY KEY, display_name TEXT, rating INTEGER);
    CREATE TABLE rating_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT, player_id TEXT,
      before INTEGER, delta INTEGER
    );
    CREATE TABLE player_steam_ids (discord_id TEXT, steam_id TEXT);
  `);

  const blue = ["b1", "b2", "b3", "b4"];
  const red = ["r1", "r2", "r3", "r4"];
  const steamFor = id => `STEAM_0:1:${id.startsWith("b") ? Number(id.slice(1)) : Number(id.slice(1)) + 4}`;
  db.prepare(`INSERT INTO matches VALUES (?, 'BLUE', 'completed', ?, ?, 'STANDARD', 1)`)
    .run("API123", JSON.stringify(blue), JSON.stringify(red));
  const insertRating = db.prepare("INSERT INTO ratings VALUES (?, ?, 2000)");
  const insertChange = db.prepare("INSERT INTO rating_changes(match_id,player_id,before,delta) VALUES ('API123',?,?,?)");
  const insertLink = db.prepare("INSERT INTO player_steam_ids VALUES (?, ?)");
  for (const id of [...blue, ...red]) {
    insertRating.run(id, `Player ${id}`);
    insertChange.run(id, 2000, id.startsWith("b") ? 20 : -20);
    insertLink.run(id, steamFor(id));
  }

  const sent = [];
  const channel = { async send(content) { sent.push(content); } };
  const client = {
    channels: {
      cache: { get: () => channel },
      fetch: async () => channel,
    },
  };
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        match: {
          id: "API123",
          status: "completed",
          nn_mvp: {
            formula_version: "nn-mvp-v1",
            available: true,
            players: apiPlayers,
          },
        },
      };
    },
  });
  const logger = { info() {}, warn() {}, error() {} };
  const service = new EloShadowService({
    db,
    client,
    channelId: "recap",
    mode: "shadow",
    fetch,
    requireLocalImport: false,
    initialDelayMs: 0,
    pollIntervalMs: 1000,
    maxAttempts: 1,
    logger,
  });
  return { db, sent, service };
}

function eightApiPlayers() {
  return ["b1", "b2", "b3", "b4", "r1", "r2", "r3", "r4"].map((id, index) => ({
    steam_id: `STEAM_0:1:${id.startsWith("b") ? Number(id.slice(1)) : Number(id.slice(1)) + 4}`,
    display_name: `Player ${id}`,
    final_score: 160 - index * 20,
  }));
}

test("service maps official roster, persists the snapshot, and posts to recap", async () => {
  const h = serviceHarness(eightApiPlayers());
  const snapshot = await h.service.runNow("API123");

  assert.equal(snapshot.fallbackReason, null);
  assert.equal(snapshot.teams.blue.length, 4);
  assert.equal(snapshot.teams.red.length, 4);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /Elo V2 Shadow/);
  assert.match(h.sent[0], /V1 \*\*\+20\*\*/);
  assert.match(h.sent[0], /15–35/);
  assert.match(h.sent[0], /20–30/);
  const row = h.db.prepare("SELECT status, formula_version, posted_at, payload_json FROM elo_shadow_results WHERE match_id='API123'").get();
  assert.equal(row.status, "posted");
  assert.equal(row.formula_version, "nn-mvp-v1");
  assert.ok(row.posted_at);
  assert.equal(JSON.parse(row.payload_json).pools.blue, 80);
  assert.equal(JSON.parse(row.payload_json).scenarios.gentle.label, "20%-30%");
  h.db.close();
});

test("a ninth performance row is recorded as an equal-share fallback", async () => {
  const players = eightApiPlayers();
  players.push({ steam_id: "STEAM_0:1:999", display_name: "Sub", final_score: 999 });
  const h = serviceHarness(players);
  const snapshot = await h.service.runNow("API123");

  assert.equal(snapshot.fallbackReason, "performance_rows_9");
  assert.deepEqual(snapshot.teams.blue.map(p => p.shadowDelta), [20, 20, 20, 20]);
  assert.deepEqual(snapshot.teams.red.map(p => p.shadowDelta), [-20, -20, -20, -20]);
  assert.deepEqual(snapshot.scenarios.gentle.teams.blue.map(p => p.shadowDelta), [20, 20, 20, 20]);
  assert.deepEqual(snapshot.scenarios.gentle.teams.red.map(p => p.shadowDelta), [-20, -20, -20, -20]);
  assert.match(h.sent[0], /returned 9 performance rows/);
  h.db.close();
});
