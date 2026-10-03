"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assignOffensePlayers,
  canAddAsOffense,
  offenseCapacity,
  offenseMaxPerTeam,
} = require("../lib/offense");
const { register } = require("../commands/queue");
const { finalizeMatch } = require("../commands/voteFlow");

const player = id => ({ id: String(id), name: `Player ${id}` });

test("offense players alternate teams and respect the per-team cap", () => {
  const result = assignOffensePlayers([player(1), player(2), player(3)], {
    maxPerTeam: 1,
    random: () => 0, // blue first
  });
  assert.deepEqual(result.blue.map(p => p.id), ["1"]);
  assert.deepEqual(result.red.map(p => p.id), ["2"]);
  assert.deepEqual(result.remaining.map(p => p.id), ["3"]);

  const two = assignOffensePlayers([player(1), player(2), player(3)], {
    maxPerTeam: 2,
    random: () => 0.9, // red first
  });
  assert.deepEqual(two.red.map(p => p.id), ["1", "3"]);
  assert.deepEqual(two.blue.map(p => p.id), ["2"]);
});

test("offense assignment skips roster players and keeps locked players waiting", () => {
  const result = assignOffensePlayers([player(1), player(2), player(3)], {
    excludeIds: ["1"],
    lockedPlayers: new Map([["2", "OTHER"]]),
    maxPerTeam: 1,
    random: () => 0,
  });
  assert.deepEqual(result.blue.map(p => p.id), ["3"]);
  assert.deepEqual(result.red, []);
  assert.deepEqual(result.remaining.map(p => p.id), ["2"]);
});

test("offense capacity reads the setting and clamps bad values", () => {
  const settingsWith = value => ({ getNumber: () => value });
  assert.equal(offenseMaxPerTeam({}), 1);
  assert.equal(offenseCapacity(settingsWith(2)), 4);
  assert.equal(offenseCapacity(settingsWith(0)), 0);
  assert.equal(offenseMaxPerTeam(settingsWith(99)), 4);
  assert.equal(offenseMaxPerTeam(settingsWith(-3)), 0);
  assert.equal(offenseMaxPerTeam(settingsWith("x")), 1);
});

test("offense role restriction applies only when configured", () => {
  const member = roles => ({ roles: { cache: new Set(roles) } });
  assert.equal(canAddAsOffense(member([]), { roles: {} }), true);

  const config = { roles: { offense: "off-role", admin: "admin-role" } };
  assert.equal(canAddAsOffense(member([]), config), false);
  assert.equal(canAddAsOffense(member(["off-role"]), config), true);
  assert.equal(canAddAsOffense(member(["admin-role"]), config), true);
  assert.equal(canAddAsOffense(null, config), false);
});

function setupQueue({ config: configOverrides = {}, settings } = {}) {
  const registry = new Map();
  const state = { queue: [], offenseQueue: [], MAX_PLAYERS: 8, lockedPlayers: new Map() };
  const posted = [];
  const channel = {
    id: "pickup",
    async send(payload) { posted.push(payload); return {}; },
  };
  register(registry, {
    client: null,
    config: { channels: { pickup: "pickup" }, roles: {}, ...configOverrides },
    state,
    elo: { getRating: () => 1941 },
    banStore: { getBan: () => null },
    settings: settings || { getNumber: (_key, fallback) => fallback },
    privacy: { isHidden: () => false },
    steamLinks: null,
    runRconCommand: null,
  });
  const replies = [];
  const message = (id, roles = []) => ({
    channel,
    client: null,
    author: { id: String(id), username: `user${id}`, send: async () => {} },
    member: { displayName: `Player ${id}`, roles: { cache: new Set(roles) } },
    reply: async text => { replies.push({ id: String(id), text }); },
  });
  return { registry, state, message, posted, replies };
}

test("full-time offense does not count toward filling the queue", async t => {
  const runs = [];
  const previousRunner = global.runFullVoteFlow;
  global.runFullVoteFlow = msg => { runs.push(msg); };
  t.after(() => { global.runFullVoteFlow = previousRunner; });

  const { registry, state, message, posted } = setupQueue();

  await registry.get("addoff")(message("o1"));
  assert.deepEqual(state.offenseQueue.map(p => p.id), ["o1"]);
  assert.equal(state.queue.length, 0);

  const board = posted.at(-1).embeds[0].data;
  assert.equal(board.title, "Player Queue — (0/8)");
  assert.ok(board.fields.some(f => f.name.startsWith("Full-time Offense (1)") && f.value.includes("Player o1")));

  for (let i = 1; i <= 7; i++) await registry.get("add")(message(`p${i}`));
  assert.equal(state.queue.length, 7);
  assert.equal(runs.length, 0, "an offense player must not complete the queue");

  await registry.get("add")(message("p8"));
  assert.equal(runs.length, 1);
});

test("switching between regular and offense moves the player", async () => {
  const { registry, state, message } = setupQueue();

  await registry.get("++")(message("a"));
  await registry.get("++off")(message("a"));
  assert.equal(state.queue.length, 0);
  assert.deepEqual(state.offenseQueue.map(p => p.id), ["a"]);

  await registry.get("add")(message("a"));
  assert.deepEqual(state.queue.map(p => p.id), ["a"]);
  assert.equal(state.offenseQueue.length, 0);
});

test("offense spots are capped and the role restriction is enforced", async () => {
  const { registry, state, message, replies } = setupQueue({
    config: { roles: { offense: "off-role" } },
  });

  await registry.get("addoff")(message("nope"));
  assert.equal(state.offenseQueue.length, 0);
  assert.match(replies.at(-1).text, /role required/);

  await registry.get("addoff")(message("o1", ["off-role"]));
  await registry.get("addoff")(message("o2", ["off-role"]));
  await registry.get("addoff")(message("o3", ["off-role"]));
  assert.deepEqual(state.offenseQueue.map(p => p.id), ["o1", "o2"]);
  assert.match(replies.at(-1).text, /spots are full \(2\/2\)/);
});

test("offense players can add and leave during a vote without canceling it", async () => {
  const { registry, state, message, replies } = setupQueue();
  let canceled = 0;
  state.queue = Array.from({ length: 8 }, (_, i) => player(`p${i}`));
  state.isVotingInProgress = true;
  state.vote = { cancelVote: async () => { canceled++; } };

  await registry.get("addoff")(message("o1"));
  assert.deepEqual(state.offenseQueue.map(p => p.id), ["o1"]);

  await registry.get("--")(message("o1"));
  assert.equal(state.offenseQueue.length, 0);
  assert.equal(canceled, 0);
  assert.equal(state.queue.length, 8);

  // A voting player cannot dodge into offense mid-vote.
  await registry.get("addoff")(message("p0"));
  assert.equal(state.offenseQueue.length, 0);
  assert.match(replies.at(-1).text, /part of the current vote/);
});

test("finalized matches keep offense players out of the rated roster", async t => {
  const previousStreaks = global.__winStreakStore;
  global.__winStreakStore = { get: () => 0 };
  t.after(() => { global.__winStreakStore = previousStreaks; });

  const inserts = [];
  const elo = {
    getRating: () => 2000,
    db: {
      exec: () => {},
      prepare: sql => ({
        all: () => [],
        get: () => null,
        run: (...args) => { if (/INSERT INTO matches/.test(sql)) inserts.push({ sql, args }); },
      }),
    },
  };
  const regulars = Array.from({ length: 8 }, (_, i) => player(i + 1));
  const state = {
    queue: regulars.map(p => ({ ...p })),
    queueSnapshot: regulars.map(p => ({ ...p })),
    offenseQueue: [player("o1"), player("o2"), player("o3")],
    MAX_PLAYERS: 8,
    matches: [],
    lockedServers: new Set(),
    lockedPlayers: new Map(),
  };
  const sent = [];
  const channel = { async send(payload) { sent.push(payload); return {}; } };

  await finalizeMatch(
    channel,
    { persistQueueSoon: () => {} },
    { getNumber: (_key, fallback) => fallback },
    state,
    { name: "East", ip: "127.0.0.1:27015" },
    { name: "2fort", mirv: 0 },
    elo,
    {},
    {},
    { channels: {} },
    "STANDARD",
    {},
    "TESTMATCH",
  );

  const record = state.matches.find(m => m.id === "TESTMATCH" && m.blueTeam);
  const rosterIds = [...record.blueTeam, ...record.redTeam].map(p => String(p.id));
  assert.equal(rosterIds.length, 8);
  assert.ok(!rosterIds.some(id => id.startsWith("o")), "offense players must not be on the rated roster");
  assert.equal(record.offense.blue.length, 1);
  assert.equal(record.offense.red.length, 1);

  const insert = inserts.at(-1);
  const blueIds = JSON.parse(insert.args[9]);
  const redIds = JSON.parse(insert.args[10]);
  const offenseIds = JSON.parse(insert.args[12]);
  assert.ok(![...blueIds, ...redIds].some(id => String(id).startsWith("o")));
  assert.deepEqual([...offenseIds.blue, ...offenseIds.red].sort(), ["o1", "o2"]);

  // Both assigned offense players are locked to the match; the third waits.
  assert.equal(state.lockedPlayers.get("o1"), "TESTMATCH");
  assert.equal(state.lockedPlayers.get("o2"), "TESTMATCH");
  assert.deepEqual(state.offenseQueue.map(p => p.id), ["o3"]);

  const ready = sent.find(p => p?.embeds?.[0]?.data?.title?.startsWith("Match Ready"));
  const fieldText = ready.embeds[0].data.fields.map(f => f.value).join("\n");
  assert.match(fieldText, /⚔️ Player o1 \*\(full-time offense, no Elo\)\*/);
});
