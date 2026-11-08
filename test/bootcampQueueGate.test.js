"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canJoinQueue } = require("../lib/queueGate");
const { register } = require("../commands/queue");

test("queue access stays open when the license gate is not configured", () => {
  assert.equal(canJoinQueue(null, {}), true);
});

test("configured gate requires the license or admin role", () => {
  const config = { roles: { queueRequired: "license", admin: "admin" } };
  const member = ids => ({ roles: { cache: new Set(ids) } });
  assert.equal(canJoinQueue(member([]), config), false);
  assert.equal(canJoinQueue(member(["license"]), config), true);
  assert.equal(canJoinQueue(member(["admin"]), config), true);
  assert.equal(canJoinQueue(null, config), false);
});

test("Bootcamp gate also protects in-game HLDS !add events", async () => {
  const registry = new Map();
  const replies = [];
  const member = { displayName: "Trainee", roles: { cache: new Set() } };
  const channel = {
    isTextBased: () => true,
    async send(value) { replies.push(value); },
    guild: { members: { fetch: async () => member } },
  };
  const rcon = [];
  const state = { queue: [], offenseQueue: [], MAX_PLAYERS: 8, lockedPlayers: new Map() };
  register(registry, {
    client: { channels: { fetch: async () => channel } },
    config: { channels: { pickup: "pickup" }, roles: { queueRequired: "licensed", admin: "admin" }, bootcampQueueGateEnabled: true },
    state,
    elo: { getRating: () => 900 },
    banStore: { getBan: () => null },
    settings: { getNumber: (_key, fallback) => fallback },
    privacy: { isHidden: () => false },
    steamLinks: { getDiscordBySteam: async () => [{ discord_id: "discord-player" }] },
    runRconCommand: async (_server, command) => rcon.push(command),
  });

  const handled = await registry.handleHldsQueueEvent({
    type: "say", text: "!add", serverKey: "local", steamid: "STEAM_0:1:1", player: "Trainee", from: "127.0.0.1",
  });
  assert.equal(handled, true);
  assert.deepEqual(state.queue, []);
  assert.ok(rcon.some(line => /TFC license/i.test(line)));
});
