"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Database = require("better-sqlite3");
const { ServerReservations } = require("../oneVOne/reservations");
const { parseOneVOneLogLine } = require("../oneVOne/logParser");
const { OneVOneStore } = require("../oneVOne/store");
const { DuelManager } = require("../oneVOne/manager");
const { OneVOneServerController } = require("../oneVOne/serverController");
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

test("1v1 event lookup is endpoint-aware for same-host servers", () => {
  const state = {
    lockedServers: new Set(),
    serverReservations: new Map([
      ["1.2.3.4:27015", {
        mode: "1v1",
        serverKey: "east",
        playerSteamIds: ["STEAM_0:1:1", "STEAM_0:1:2"],
      }],
    ]),
  };
  const manager = new DuelManager({
    config: {},
    state,
    reservations: new ServerReservations(state),
    steamLinks: {},
  });

  assert.equal(manager.reservationFromSource({
    from: "1.2.3.4",
    sourcePort: 27016,
    serverKey: "eastSkill",
  }), null);
  assert.equal(manager.reservationFromSource({
    from: "1.2.3.4",
    sourcePort: 27015,
    serverKey: "east",
  })[1].serverKey, "east");
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
  assert.equal(store.idExists("old"), true);
  assert.equal(store.idExists("unused"), false);
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

test("new 1v1 challenges use the standard six-character match ID", () => {
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const manager = new DuelManager({
    config: { challengeTtlMs: 1000 },
    state,
    reservations: new ServerReservations(state),
    steamLinks: { getSteamIds: async () => [] },
  });
  const result = manager.createChallenge({ id: "1" }, { id: "2", bot: false });

  assert.equal(result.ok, true);
  assert.match(result.challenge.id, /^[A-HJ-NP-Z2-9]{6}$/);
  manager.cancel(result.challenge.id, "test_cleanup");
});

test("admins can arrange a pending 1v1 between two mentioned players", async () => {
  const registry = new Map();
  let createdWith = null;
  const challenge = {
    id: "ADMIN1",
    challengerId: "111",
    challengedId: "222",
    createdByAdminId: "999",
    expiresAt: Date.now() + 60_000,
  };
  const challengeMessage = {
    id: "admin-challenge-message",
    edit: async () => challengeMessage,
    createMessageComponentCollector: () => new EventEmitter(),
  };
  const manager = {
    createChallenge: (challenger, challenged, options) => {
      createdWith = { challenger, challenged, options };
      return { ok: true, challenge };
    },
    onChallengeExpire: () => true,
  };
  registerCommands(registry, {
    config: { channelId: "pickup" },
    manager,
    adminRoleId: "admin",
  });
  const mentions = new Map([
    ["111", { id: "111", bot: false }],
    ["222", { id: "222", bot: false }],
  ]);
  let sentPayload = null;

  await registry.get("1v1")({
    author: { id: "999" },
    member: { roles: { cache: { has: id => id === "admin" } } },
    mentions: { users: mentions },
    channel: {
      id: "pickup",
      send: async payload => { sentPayload = payload; return challengeMessage; },
    },
    reply: async () => {},
  });

  assert.equal(createdWith.challenger.id, "111");
  assert.equal(createdWith.challenged.id, "222");
  assert.deepEqual(createdWith.options, { createdByAdminId: "999" });
  assert.deepEqual(sentPayload.allowedMentions.users, ["222"]);
  assert.match(sentPayload.embeds[0].data.description, /admin arranged/i);
});

test("non-admins cannot arrange a 1v1 between two other players", async () => {
  const registry = new Map();
  let createCalls = 0;
  const manager = { createChallenge: () => { createCalls += 1; } };
  registerCommands(registry, {
    config: { channelId: "pickup" },
    manager,
    adminRoleId: "admin",
  });
  const replies = [];

  await registry.get("1v1")({
    author: { id: "333" },
    member: { roles: { cache: { has: () => false } } },
    mentions: { users: new Map([
      ["111", { id: "111", bot: false }],
      ["222", { id: "222", bot: false }],
    ]) },
    channel: { id: "pickup" },
    reply: async payload => replies.push(payload),
  });

  assert.equal(createCalls, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].data.description, /only admins/i);
});

test("server resolver requires exact host and port", () => {
  const result = resolveServerKey({ ip: "1.2.3.4:27016" }, {
    east: { host: "1.2.3.4", port: 27015 }, west: { host: "1.2.3.4", port: 27016 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.key, "west");
  assert.equal(resolveServerKey({ ip: "1.2.3.4:27017" }, {}).ok, false);
});

test("post-map setup applies plugin cvars through amx_cvar with enabled last", async () => {
  const sent = [];
  const controller = new OneVOneServerController({
    config: {
      serverSetupEnabled: true,
      postMapSetupDelayMs: 1,
      killGoal: 50,
      roundsToWin: 1,
    },
    runRconCommand: async (serverKey, command) => sent.push([serverKey, command]),
  });
  const result = await controller.finishSetup({
    serverKey: "east",
    playerSteamIds: ["STEAM_0:0:1", "STEAM_0:1:2"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    ["east", "amx_cvar 1v1_enabled 0"],
    ["east", 'amx_cvar 1v1_player1 "STEAM_0:0:1"'],
    ["east", 'amx_cvar 1v1_player2 "STEAM_0:1:2"'],
    ["east", 'amx_cvar 1v1_server_key "east"'],
    ["east", "amx_cvar 1v1_kill_goal 50"],
    ["east", "amx_cvar 1v1_rounds_to_win 1"],
    ["east", "amx_cvar 1v1_enabled 1"],
  ]);
});

test("map setup disables and clears any stale duel before changing map", async () => {
  const sent = [];
  const controller = new OneVOneServerController({
    config: { serverSetupEnabled: true, map: "ass_dm" },
    runRconCommand: async (serverKey, command) => sent.push([serverKey, command]),
  });

  const result = await controller.beginSetup({ serverKey: "east" });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    ["east", "amx_cvar 1v1_enabled 0"],
    ["east", 'amx_cvar 1v1_player1 ""'],
    ["east", 'amx_cvar 1v1_player2 ""'],
    ["east", 'amx_cvar 1v1_server_key "unknown"'],
    ["east", "amx_map ass_dm"],
  ]);
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

test("player joins received during post-map setup are preserved", async () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  let finishSetupResolve;
  const manager = new DuelManager({
    config: {
      dryRun: false,
      map: "ass_dm",
      setupTimeoutMs: 60_000,
      postMapSetupDelayMs: 10_000,
      joinTimeoutMs: 60_000,
      readyTimeoutMs: 60_000,
    },
    state,
    reservations,
    steamLinks: { getSteamIds: async () => [] },
    resolveServer: () => ({ ok: true, key: "east" }),
    serverController: {
      beginSetup: async () => ({ ok: true }),
      finishSetup: () => new Promise(resolve => { finishSetupResolve = resolve; }),
    },
  });
  const challenge = {
    id: "duel-joins-during-setup",
    challengerId: "1",
    challengedId: "2",
    player1SteamId: "STEAM_0:0:1",
    player2SteamId: "STEAM_0:1:2",
  };

  await manager.activate(challenge, { name: "East", ip: serverIp });
  const mapHandling = manager.handleMap({ type: "map", name: "ass_dm", from: "1.2.3.4" });
  manager.handleLifecycle({ type: "one_v_one_player_reconnect", from: "1.2.3.4", steamid: "STEAM_0:0:1" });
  manager.handleLifecycle({ type: "one_v_one_player_reconnect", from: "1.2.3.4", steamid: "STEAM_0:1:2" });
  finishSetupResolve({ ok: true });
  await mapHandling;

  const reservation = reservations.get(serverIp);
  assert.deepEqual(reservation.joined.sort(), ["STEAM_0:0:1", "STEAM_0:1:2"]);
  assert.equal(reservation.status, "waiting_for_ready");
  assert.equal(manager.timers.has(`${challenge.id}:join`), false);
  assert.equal(manager.timers.has(`${challenge.id}:ready`), true);
  manager.complete(serverIp, reservation);
});

test("player lifecycle received before the map event is preserved", async () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const manager = new DuelManager({
    config: {
      dryRun: false,
      map: "ass_dm",
      setupTimeoutMs: 60_000,
      joinTimeoutMs: 60_000,
      readyTimeoutMs: 60_000,
    },
    state,
    reservations,
    steamLinks: { getSteamIds: async () => [] },
    resolveServer: () => ({ ok: true, key: "east" }),
    serverController: {
      beginSetup: async () => ({ ok: true }),
      finishSetup: async () => ({ ok: true }),
    },
  });
  const challenge = {
    id: "duel-early-lifecycle",
    challengerId: "1",
    challengedId: "2",
    player1SteamId: "STEAM_0:0:1",
    player2SteamId: "STEAM_0:1:2",
  };

  await manager.activate(challenge, { name: "East", ip: serverIp });
  manager.handleLifecycle({ type: "one_v_one_player_reconnect", from: "1.2.3.4", steamid: "STEAM_0:0:1" });
  manager.handleLifecycle({ type: "one_v_one_player_reconnect", from: "1.2.3.4", steamid: "STEAM_0:1:2" });
  await manager.handleMap({ type: "map", name: "ass_dm", from: "1.2.3.4" });

  const reservation = reservations.get(serverIp);
  assert.deepEqual(reservation.joined.sort(), ["STEAM_0:0:1", "STEAM_0:1:2"]);
  assert.equal(reservation.status, "waiting_for_ready");
  assert.equal(manager.timers.has(`${challenge.id}:join`), false);
  assert.equal(manager.timers.has(`${challenge.id}:ready`), true);
  manager.complete(serverIp, reservation);
});

test("match start clears both pre-match timeout timers", () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const manager = new DuelManager({
    config: {}, state, reservations,
    steamLinks: { getSteamIds: async () => [] },
  });
  reservations.reserve(serverIp, {
    id: "duel-started",
    mode: "1v1",
    serverKey: "east",
    playerSteamIds: ["STEAM_0:0:1", "STEAM_0:1:2"],
    status: "waiting_for_players",
  });
  manager.setTimer("duel-started", "join", 60_000, () => {});
  manager.setTimer("duel-started", "ready", 60_000, () => {});

  manager.handleLifecycle({ type: "one_v_one_match_start", from: "1.2.3.4" });

  assert.equal(reservations.get(serverIp).status, "active");
  assert.equal(manager.timers.has("duel-started:join"), false);
  assert.equal(manager.timers.has("duel-started:ready"), false);
  manager.complete(serverIp, reservations.get(serverIp));
});

test("ready events prove players joined even when join events were lost", () => {
  const serverIp = "1.2.3.4:27015";
  const state = { lockedServers: new Set(), lockedPlayers: new Map(), servers: [] };
  const reservations = new ServerReservations(state);
  const manager = new DuelManager({
    config: { readyTimeoutMs: 60_000 }, state, reservations,
    steamLinks: { getSteamIds: async () => [] },
  });
  reservations.reserve(serverIp, {
    id: "duel-ready-without-joins",
    mode: "1v1",
    serverKey: "east",
    playerSteamIds: ["STEAM_0:0:1", "STEAM_0:1:2"],
    status: "waiting_for_players",
  });
  manager.setTimer("duel-ready-without-joins", "join", 60_000, () => {});

  manager.handleLifecycle({ type: "one_v_one_player_ready", from: "1.2.3.4", steamid: "STEAM_0:0:1" });
  manager.handleLifecycle({ type: "one_v_one_player_ready", from: "1.2.3.4", steamid: "STEAM_0:1:2" });

  const reservation = reservations.get(serverIp);
  assert.deepEqual(reservation.joined.sort(), ["STEAM_0:0:1", "STEAM_0:1:2"]);
  assert.deepEqual(reservation.ready.sort(), ["STEAM_0:0:1", "STEAM_0:1:2"]);
  assert.equal(reservation.status, "waiting_for_ready");
  assert.equal(manager.timers.has("duel-ready-without-joins:join"), false);
  assert.equal(manager.timers.has("duel-ready-without-joins:ready"), true);
  manager.complete(serverIp, reservation);
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
      finishSetup: async () => ({ ok: false, failedCommand: "amx_cvar 1v1_enabled 1", error: new Error("RCON failed") }),
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

test("both duelists can acknowledge and complete the server vote", async () => {
  const registry = new Map();
  const collector = new EventEmitter();
  collector.stop = reason => collector.emit("end", new Map(), reason);
  const edits = [];
  const voteMessage = {
    edit: async payload => { edits.push(payload); return voteMessage; },
    createMessageComponentCollector: options => { collector.options = options; return collector; },
  };
  const challenge = {
    id: "VOTE12",
    challengerId: "111",
    challengedId: "222",
  };
  let activated = null;
  const manager = {
    accept: async () => ({
      ok: true,
      challenge,
      availableServers: [
        { name: "East", ip: "1.2.3.4:27015" },
        { name: "West", ip: "5.6.7.8:27015" },
      ],
    }),
    activate: async (accepted, server) => {
      activated = { accepted, server };
      return { ok: true, simulated: true };
    },
    cancel: () => null,
  };
  registerCommands(registry, {
    config: { channelId: "pickup", dryRun: true, map: "ass_dm", killGoal: 50 },
    manager,
  });
  const message = {
    author: { id: "222" },
    channel: {
      id: "pickup",
      send: async () => voteMessage,
    },
    reply: async () => {},
  };

  await registry.get("accept")(message);
  const collect = collector.listeners("collect")[0];
  assert.equal(typeof collect, "function");
  assert.equal(collector.options.filter({ customId: "1v1_server_VOTE12_0" }), true);

  const acknowledgements = [];
  await collect({
    customId: "1v1_server_VOTE12_0",
    user: { id: "111", username: "One" },
    member: { displayName: "One" },
    deferUpdate: async () => acknowledgements.push("111"),
  });
  await collect({
    customId: "1v1_server_VOTE12_1",
    user: { id: "222", username: "Two" },
    member: { displayName: "Two" },
    deferUpdate: async () => acknowledgements.push("222"),
  });

  assert.deepEqual(acknowledgements, ["111", "222"]);
  assert.equal(edits.length >= 2, true);
  assert.equal(activated.accepted, challenge);
  assert.ok(["East", "West"].includes(activated.server.name));
});

test("the challenged player can acknowledge the Accept button", async () => {
  const registry = new Map();
  const challengeCollector = new EventEmitter();
  challengeCollector.stop = reason => challengeCollector.emit("end", new Map(), reason);
  const voteCollector = new EventEmitter();
  const challengeMessage = {
    id: "challenge-message",
    edit: async () => challengeMessage,
    createMessageComponentCollector: () => challengeCollector,
  };
  const voteMessage = {
    edit: async () => voteMessage,
    createMessageComponentCollector: () => voteCollector,
  };
  let sends = 0;
  const challenge = {
    id: "ACPT12",
    challengerId: "111",
    challengedId: "222",
    expiresAt: Date.now() + 60_000,
    status: "pending",
  };
  const manager = {
    createChallenge: () => ({ ok: true, challenge }),
    onChallengeExpire: () => true,
    incomingFor: userId => String(userId) === "222" && challenge.status === "pending" ? challenge : null,
    accept: async () => {
      challenge.status = "accepted";
      return {
        ok: true,
        challenge,
        availableServers: [{ name: "East", ip: "1.2.3.4:27015" }],
      };
    },
    cancel: () => null,
  };
  registerCommands(registry, {
    config: { channelId: "pickup", dryRun: true, map: "ass_dm", killGoal: 50 },
    manager,
  });
  const channel = {
    id: "pickup",
    send: async () => (++sends === 1 ? challengeMessage : voteMessage),
  };
  await registry.get("1v1")({
    author: { id: "111" },
    mentions: { users: { first: () => ({ id: "222", bot: false }) } },
    channel,
    reply: async () => {},
  });

  let acknowledged = false;
  const interaction = {
    customId: "1v1_accept_ACPT12",
    user: { id: "222", username: "Two" },
    channel,
    deferUpdate: async () => { acknowledged = true; },
    followUp: async () => {},
  };
  await challengeCollector.listeners("collect")[0](interaction);

  assert.equal(acknowledged, true);
  assert.equal(challenge.status, "accepted");
  assert.equal(sends, 2);
});
