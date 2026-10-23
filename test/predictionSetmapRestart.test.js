"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { register } = require("../commands/setmap");

async function setup(t, restartRequest) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const previousRole = process.env.ADMIN_ROLE_ID;
  process.env.ADMIN_ROLE_ID = "admin";
  t.after(() => { if (previousRole === undefined) delete process.env.ADMIN_ROLE_ID; else process.env.ADMIN_ROLE_ID = previousRole; });
  db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,map_name TEXT,status TEXT)");
  db.prepare("INSERT INTO matches VALUES (?, ?, 'in_progress')").run("MATCH1", "shutdown2");
  const loadedAt = new Map([["east", 500]]);
  const state = { matches: [{ id: "MATCH1", map: "shutdown2", map_name: "shutdown2" }], restartRequest, hldsMapLoadedAt: loadedAt };
  const sent = [];
  const message = {
    author: { id: "admin" }, member: { roles: { cache: { has: role => role === "admin" } } },
    reply: async content => sent.push(content), channel: { send: async content => sent.push(content) },
  };
  const reg = new Map();
  await register(reg, { state, elo: { db }, config: {} });
  return { db, state, sent, command: args => reg.get("setmap")(message, args), loadedAt };
}

for (const used of [false, true]) {
  test(`setmap changes the matching restart target without resetting used=${used} or its timing`, async t => {
    const request = { matchId: "MATCH1", serverIp: "192.0.2.1:27015", serverKey: "east", map: "shutdown2", used, armedAt: 100, disarmedReason: "map_already_loaded" };
    const { db, state, command, loadedAt } = await setup(t, request);
    await command(["MATCH1", "openfire"]);
    assert.equal(db.prepare("SELECT map_name FROM matches WHERE match_id='MATCH1'").get().map_name, "openfire");
    assert.equal(state.matches[0].map, "openfire");
    assert.equal(state.matches[0].map_name, "openfire");
    assert.equal(state.restartRequest, request);
    assert.deepEqual(state.restartRequest, { matchId: "MATCH1", serverIp: "192.0.2.1:27015", serverKey: "east", map: "openfire", used, armedAt: 100, disarmedReason: "map_already_loaded" });
    assert.equal(state.hldsMapLoadedAt, loadedAt);
    assert.equal(state.hldsMapLoadedAt.get("east"), 500);
  });
}

test("setmap leaves another match's restart request untouched", async t => {
  const request = { matchId: "OTHER1", serverIp: "192.0.2.2:27015", serverKey: "west", map: "well", used: true, armedAt: 100 };
  const original = { ...request };
  const { db, state, command } = await setup(t, request);
  await command(["MATCH1", "openfire"]);
  assert.equal(db.prepare("SELECT map_name FROM matches WHERE match_id='MATCH1'").get().map_name, "openfire");
  assert.equal(state.restartRequest, request);
  assert.deepEqual(state.restartRequest, original);
});

test("a setmap no-op preserves the consumed restart request and original load time", async t => {
  const request = { matchId: "MATCH1", serverIp: "192.0.2.1:27015", serverKey: "east", map: "shutdown2", used: true, armedAt: 100 };
  const original = { ...request };
  const { db, state, command, loadedAt } = await setup(t, request);
  await command(["MATCH1", "shutdown2"]);
  assert.equal(db.prepare("SELECT map_name FROM matches WHERE match_id='MATCH1'").get().map_name, "shutdown2");
  assert.equal(state.restartRequest, request);
  assert.deepEqual(state.restartRequest, original);
  assert.equal(state.hldsMapLoadedAt, loadedAt);
  assert.equal(state.hldsMapLoadedAt.get("east"), 500);
});
