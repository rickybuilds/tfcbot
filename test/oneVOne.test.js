"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { ServerReservations } = require("../oneVOne/reservations");
const { parseOneVOneLogLine } = require("../oneVOne/logParser");
const { OneVOneStore } = require("../oneVOne/store");
const { DuelManager } = require("../oneVOne/manager");
const { resolveServerKey } = require("../oneVOne/serverResolver");
const { registerCommands } = require("../oneVOne/commands");

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

test("live activation reports ready after the expected map is configured", async () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const calls = [];
  const statuses = [];
  const manager = new DuelManager({
    config: {
      dryRun: false,
      map: "ass_dm",
      setupTimeoutMs: 60_000,
      joinTimeoutMs: 60_000,
    },
    state,
    reservations,
    steamLinks: { getSteamIds: async () => [] },
    resolveServer: () => ({ ok: true, key: "east" }),
    serverController: {
      beginSetup: async reservation => { calls.push(["begin", reservation.serverKey]); return { ok: true }; },
      finishSetup: async reservation => { calls.push(["finish", reservation.serverKey]); return { ok: true }; },
    },
  });
  const challenge = {
    id: "duel-ready",
    challengerId: "1",
    challengedId: "2",
    player1SteamId: "STEAM_0:0:1",
    player2SteamId: "STEAM_0:1:2",
  };
  manager.pending.set(challenge.id, challenge);
  manager.pendingByPlayer.set("1", challenge.id);
  manager.pendingByPlayer.set("2", challenge.id);

  const activated = await manager.activate(challenge, { name: "East", ip: serverIp }, {
    onStatus: status => statuses.push(status),
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.waitingForMap, true);
  assert.deepEqual(calls, [["begin", "east"]]);

  const handled = await manager.handleMap({ type: "map", name: "ass_dm", from: "1.2.3.4" });
  assert.equal(handled, true);
  assert.deepEqual(calls, [["begin", "east"], ["finish", "east"]]);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].type, "ready");
  assert.equal(statuses[0].reservation.status, "waiting_for_players");
  assert.equal(reservations.get(serverIp).status, "waiting_for_players");

  manager.complete(serverIp, reservations.get(serverIp));
});

test("post-map setup failure is quarantined and reported", async () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const statuses = [];
  const manager = new DuelManager({
    config: {
      dryRun: false,
      map: "ass_dm",
      setupTimeoutMs: 60_000,
      joinTimeoutMs: 60_000,
    },
    state,
    reservations,
    steamLinks: { getSteamIds: async () => [] },
    resolveServer: () => ({ ok: true, key: "east" }),
    serverController: {
      beginSetup: async () => ({ ok: true }),
      finishSetup: async () => ({ ok: false, failedCommand: "1v1_enabled 1", error: new Error("RCON failed") }),
    },
  });
  const challenge = {
    id: "duel-failed",
    challengerId: "1",
    challengedId: "2",
    player1SteamId: "STEAM_0:0:1",
    player2SteamId: "STEAM_0:1:2",
  };

  await manager.activate(challenge, { name: "East", ip: serverIp }, {
    onStatus: status => statuses.push(status),
  });
  const handled = await manager.handleMap({ type: "map", name: "ass_dm", from: "1.2.3.4" });

  assert.equal(handled, true);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].type, "failed");
  assert.equal(statuses[0].reason, "post_map_setup_failed");
  assert.equal(reservations.get(serverIp).status, "quarantined");
  assert.equal(state.lockedServers.has(serverIp), true);
});

test("admin cancellation by player mention finds an active duel", async () => {
  const registry = new Map();
  let cancelledId = null;
  const manager = {
    pendingByPlayer: new Map(),
    activeByPlayer: new Map([["2", "active-duel"]]),
    cancel: () => null,
    cancelActive: async id => { cancelledId = id; return { ok: true }; },
  };
  registerCommands(registry, {
    config: { channelId: "pickup" },
    manager,
    adminRoleId: "admin",
  });
  const sent = [];
  await registry.get("1v1cancel")({
    author: { id: "admin-user" },
    content: "!1v1cancel <@2>",
    member: { roles: { cache: { has: id => id === "admin" } } },
    mentions: { users: { first: () => ({ id: "2" }) } },
    channel: { id: "pickup", send: async payload => { sent.push(payload); return payload; } },
    reply: async payload => payload,
  });

  assert.equal(cancelledId, "active-duel");
  assert.equal(sent.length, 1);
});
