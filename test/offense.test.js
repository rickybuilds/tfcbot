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

test("offense assignment rechecks current Elo and drops old ineligible entries", () => {
  const ratings = { high: 2300, boundary: 1000, low: 999, unknown: NaN };
  const result = assignOffensePlayers(Object.keys(ratings).map(player), {
    maxPerTeam: 1, random: () => 0, ratingForPlayer: p => ratings[p.id],
  });
  assert.deepEqual(result.blue.map(p => p.id), ["low"]);
  assert.deepEqual(result.red, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.ineligible.map(p => p.id), ["high", "boundary", "unknown"]);
});

function setupQueue({ config: configOverrides = {}, settings, rating = 900, ban = null } = {}) {
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
    elo: { getRating: () => { if (rating instanceof Error) throw rating; return typeof rating === "function" ? rating() : rating; } },
    banStore: { getBan: () => ban },
    settings: settings || { getNumber: (_key, fallback) => fallback },
    privacy: { isHidden: () => false },
    steamLinks: null,
    runRconCommand: null,
  });
  const replies = [];
  const directMessages = [];
  const message = (id, roles = []) => ({
    channel,
    client: null,
    author: { id: String(id), username: `user${id}`, send: async text => directMessages.push(text) },
    member: { displayName: `Player ${id}`, roles: { cache: new Set(roles) } },
    reply: async text => { replies.push({ id: String(id), text }); },
  });
  return { registry, state, message, posted, replies, directMessages };
}

test("all addoff aliases block high Elo without publishing or logging the player's Elo", async () => {
  const logs = [];
  const previousLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    for (const rating of [1000, 2300]) {
      for (const command of ["addoff", "addoffense", "++off"]) {
        const h = setupQueue({ rating, config: { roles: { offense: "off-role", admin: "admin-role" } } });
        h.state.queue.push(player("high"));
        await h.registry.get(command)(h.message("high", ["off-role", "admin-role"]));
        assert.deepEqual(h.state.offenseQueue, []);
        assert.equal(h.state.queue.length, 1);
        assert.match(h.replies.at(-1).text, /below 1000/);
        assert.doesNotMatch(h.replies.at(-1).text, /Your current Elo|2300/);
        assert.ok(!logs.some(line => line.includes("[addoff]")));
      }
    }
  } finally { console.log = previousLog; }
});

test("addoff accepts Elo 999 silently while a regular 2300-Elo add remains allowed", async () => {
  const logs = [];
  const previousLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const low = setupQueue({ rating: 999 });
    await low.registry.get("addoff")(low.message("low"));
    assert.deepEqual(low.state.offenseQueue.map(p => p.id), ["low"]);
    assert.ok(!logs.some(line => line.includes("[addoff]")));
    const high = setupQueue({ rating: 2300 });
    await high.registry.get("add")(high.message("high"));
    assert.deepEqual(high.state.queue.map(p => p.id), ["high"]);
  } finally { console.log = previousLog; }
});

test("addoff denial replies share a per-player 60-second cooldown across aliases", async t => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const h = setupQueue({ rating: 2352 });
  await Promise.all(Array.from({ length: 12 }, (_, i) => h.registry.get(["addoff", "addoffense", "++off"][i % 3])(h.message("spam"))));
  assert.equal(h.replies.length, 1);
  assert.doesNotMatch(h.replies[0].text, /2352/);
  clock += 59999;
  await h.registry.get("addoff")(h.message("spam"));
  assert.equal(h.replies.length, 1);
  await h.registry.get("addoff")(h.message("another-player"));
  assert.equal(h.replies.length, 2);
  clock += 1;
  await h.registry.get("++off")(h.message("spam"));
  assert.equal(h.replies.length, 3);
  assert.deepEqual(h.state.offenseQueue, []);
});

test("reply cooldown does not prevent a player who becomes eligible from adding", async () => {
  let rating = 2352;
  const h = setupQueue({ rating: () => rating });
  await h.registry.get("addoff")(h.message("changed"));
  rating = 999;
  await h.registry.get("addoff")(h.message("changed"));
  assert.deepEqual(h.state.offenseQueue.map(p => p.id), ["changed"]);
  assert.equal(h.replies.length, 1);
});

test("addoff ban DMs share the denial cooldown with public replies", async () => {
  let rating = 900;
  const h = setupQueue({ rating: () => rating, ban: { gamesRemaining: 3 } });
  await h.registry.get("addoff")(h.message("banned"));
  await h.registry.get("++off")(h.message("banned"));
  assert.equal(h.directMessages.length, 1);
  rating = 2352;
  await h.registry.get("addoffense")(h.message("banned"));
  assert.equal(h.replies.length, 0);
  assert.deepEqual(h.state.offenseQueue, []);
});

test("addoff blocks unavailable or invalid Elo instead of accepting it as zero", async () => {
  for (const rating of [null, undefined, NaN, Infinity, new Error("database unavailable")]) {
    const h = setupQueue({ rating: rating === undefined ? NaN : rating });
    await h.registry.get("addoff")(h.message("unknown"));
    assert.deepEqual(h.state.offenseQueue, []);
    assert.match(h.replies.at(-1).text, /verify.*Elo/i);
  }
});

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
    getRating: id => String(id).startsWith("o") ? 900 : 2000,
    db: {
      transaction: fn => fn,
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
