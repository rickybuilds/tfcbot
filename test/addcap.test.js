"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
process.env.ADMIN_ROLE_ID = "captain-test-admin";
const { register } = require("../commands/queue");

function setup({ admin = true, target = "player" } = {}) {
  const registry = new Map();
  const state = { queue: [], offenseQueue: [], MAX_PLAYERS: 8, lockedPlayers: new Map() };
  const sent = [];
  const user = { id: target, username: "Target", send: async () => {} };
  const message = {
    channel: { id: "pickup", send: async value => sent.push(value) },
    author: { id: "invoker", username: "Invoker" },
    member: { roles: { cache: new Set(admin ? ["captain-test-admin"] : []) } },
    mentions: { users: { first: () => target ? user : undefined } },
    guild: { members: { fetch: async () => ({ displayName: "Target Player" }) } },
    reply: async value => sent.push(value),
  };
  const bans = new Map();
  register(registry, {
    config: { channels: { pickup: "pickup" } }, state,
    elo: { getRating: () => 1000 }, banStore: { getBan: id => bans.get(id) },
    settings: {}, privacy: { isHidden: () => false },
  });
  let persisted = 0;
  registry.persistQueueSoon = () => persisted++;
  return { state, message, sent, bans, registry, persisted: () => persisted, run: () => registry.get("addcap")(message) };
}

test("admin addcap mention adds the target as captain and persists the queue", async () => {
  const h = setup();
  await h.run();
  assert.deepEqual(h.state.queue.map(p => [p.id, p.captain]), [["player", true]]);
  assert.equal(h.persisted(), 1);
});

test("non-admin cannot add a mentioned captain or accidentally add themselves", async () => {
  const h = setup({ admin: false });
  await h.run();
  assert.deepEqual(h.state.queue, []);
  assert.equal(h.persisted(), 0);
});

test("admin can promote an already queued player even when the queue is full", async () => {
  const h = setup();
  h.state.MAX_PLAYERS = 2;
  h.state.queue = [{ id: "player", name: "Stored Name", adlVote: true }, { id: "other" }];
  await h.run();
  assert.equal(h.state.queue.length, 2);
  assert.equal(h.state.queue[0].captain, true);
  assert.equal(h.state.queue[0].adlVote, true);
  assert.equal(h.state.queue[0].name, "Stored Name");
});

test("admin cannot assign a third captain", async () => {
  const h = setup();
  h.state.queue = [{ id: "one", captain: true }, { id: "two", captain: true }];
  await h.run();
  assert.deepEqual(h.state.queue.map(p => p.id), ["one", "two"]);
});

test("admin captain adds respect channel, vote, capacity, bans, and match locks", async t => {
  const cases = {
    channel: h => { h.message.channel.id = "elsewhere"; },
    vote: h => { h.state.vote = {}; },
    startup: h => { h.state.isVoteStarting = true; },
    full: h => { h.state.MAX_PLAYERS = 1; h.state.queue.push({ id: "other" }); },
    ban: h => { h.bans.set("player", { gamesRemaining: 1 }); },
    ghost: h => { h.state.ghostBans = { player: { gamesRemaining: 1 } }; },
    lock: h => { h.state.lockedPlayers.set("player", "MATCH"); },
  };
  for (const [name, prepare] of Object.entries(cases)) await t.test(name, async () => {
    const h = setup();
    prepare(h);
    await h.run();
    assert.ok(!h.state.queue.some(p => p.id === "player" || p.id === "invoker"));
    assert.equal(h.persisted(), 0);
  });
});

test("addcap without a mention still lets players volunteer themselves", async () => {
  const h = setup({ admin: false, target: null });
  await h.run();
  assert.deepEqual(h.state.queue.map(p => [p.id, p.captain]), [["invoker", true]]);
});

test("addplayer command arguments do not mark the target as captain", async () => {
  const h = setup();
  await h.registry.get("addplayer")(h.message, ["<@player>"]);
  assert.equal(h.state.queue[0].id, "player");
  assert.ok(!h.state.queue[0].captain);
});
