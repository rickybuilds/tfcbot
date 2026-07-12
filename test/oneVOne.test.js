"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { ServerReservations } = require("../oneVOne/reservations");
const { parseOneVOneLogLine } = require("../oneVOne/logParser");
const { OneVOneStore } = require("../oneVOne/store");
const { DuelManager } = require("../oneVOne/manager");
const { resolveServerKey } = require("../oneVOne/serverResolver");

test("reservation is atomic and mirrors legacy pickup lock", () => {
  const state = { lockedServers: new Set() };
  const reservations = new ServerReservations(state);
  assert.equal(reservations.reserve("1.2.3.4:27015", { id: "duel-1", mode: "1v1" }).ok, true);
  assert.equal(reservations.reserve("1.2.3.4:27015", { id: "duel-2", mode: "1v1" }).ok, false);
  assert.equal(state.lockedServers.has("1.2.3.4:27015"), true);
  assert.equal(reservations.release("1.2.3.4:27015", "wrong").ok, false);
  assert.equal(reservations.release("1.2.3.4:27015", "duel-1").ok, true);
});

test("machine-readable match end parses and validates", () => {
  const event = parseOneVOneLogLine('[TFCBOT] 1V1_MATCH_END server=east map=ass_dm winner=STEAM_0:0:59055 loser=STEAM_0:1:12345 winner_score=50 loser_score=43 duration=487 kill_goal=50 rounds_won=1 rounds_required=1');
  assert.equal(event.type, "one_v_one_match_end");
  assert.equal(event.winner_score, 50);
  assert.equal(event.duration, 487);
});

test("migration is idempotent and preserves existing matches", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE matches (match_id TEXT PRIMARY KEY, created_at INTEGER); INSERT INTO matches VALUES ('old', 1)");
  const store = new OneVOneStore(db);
  store.migrate();
  store.migrate();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 1);
  assert.deepEqual(store.schemaStatus(), { matchType: true, playerFormat: true, expectedPlayers: true, scoringMode: true, duelTable: true });
  db.close();
});

test("dry-run activation never locks a real server", () => {
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const manager = new DuelManager({
    config: { dryRun: true, challengeTtlMs: 1000 }, state, reservations,
    steamLinks: { getSteamIds: async () => [] }, resolveServer: () => ({ ok: true, key: "east" }),
    serverController: { setup: async () => ({ ok: true, simulated: true }) },
  });
  const challenge = { id: "dry", challengerId: "1", challengedId: "2" };
  manager.pending.set("dry", challenge);
  manager.pendingByPlayer.set("1", "dry");
  manager.pendingByPlayer.set("2", "dry");
  return manager.activate(challenge, { ip: "1.2.3.4:27015" }).then(result => {
    assert.equal(result.simulated, true);
    assert.equal(state.lockedServers.size, 0);
  });
});

test("server resolver requires exact host and port", () => {
  const result = resolveServerKey({ ip: "1.2.3.4:27016" }, {
    east: { host: "1.2.3.4", port: 27015 }, west: { host: "1.2.3.4", port: 27016 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.key, "west");
  assert.equal(resolveServerKey({ ip: "1.2.3.4:27017" }, {}).ok, false);
});
