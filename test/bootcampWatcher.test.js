"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pollBootcampEvents,
  syncMemberRoles,
  postEvent,
  playerUrl,
  announceWeeklyChallenge,
} = require("../services/bootcampWatcher");
const { canJoinQueue } = require("../lib/queueGate");

function settingsStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback,
    setNumber: (key, value) => store.set(key, value),
  };
}

function mockClient(channel = null, guilds = new Map()) {
  return {
    channels: { fetch: async () => channel, cache: { find: () => channel } },
    guilds: { cache: guilds, fetch: async () => [...guilds.values()][0] },
  };
}

function baseApi(overrides = {}) {
  return {
    latestEventId: async () => 0,
    events: async () => [],
    recomputeLicense: async () => ({ level: "permit", endorsements: [] }),
    player: async steamId => ({ steamId, license: { level: "permit", endorsements: [] } }),
    challenge: async () => ({ challenge: null, standings: [] }),
    ...overrides,
  };
}

test("weekly challenge announcements remain disabled unless explicitly enabled", async () => {
  const original = process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED;
  delete process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED;
  let calls = 0;
  try {
    assert.equal(await announceWeeklyChallenge({ api: { challenge: async () => { calls++; } } }), false);
    assert.equal(calls, 0);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED;
    else process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED = original;
  }
});

test("weekly challenge announcement retries failed sends and records successful delivery once", async () => {
  const original = process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED;
  process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED = "true";
  const settings = settingsStore();
  let attempts = 0;
  const channel = { send: async text => { attempts++; if (attempts === 1) throw new Error("Discord offline"); return text; } };
  const ctx = { client: mockClient(channel), api: baseApi({ challenge: async () => ({ challenge: { id: 12,
    title: "Weekly run", map: "openfire", targetName: "Main" } }) }), settings, logger: { warn() {} } };
  try {
    await assert.rejects(announceWeeklyChallenge(ctx), /Discord offline/);
    assert.equal(settings.store.has("bootcamp:last_challenge_id"), false);
    await announceWeeklyChallenge(ctx);
    assert.equal(settings.store.get("bootcamp:last_challenge_id"), 12);
    await announceWeeklyChallenge(ctx);
    assert.equal(attempts, 2);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED;
    else process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED = original;
  }
});

test("player profile links target the existing query-driven Bootcamp hub", () => {
  assert.match(playerUrl("STEAM_0:1:4"), /\/bootcamp\.html\?steamid=STEAM_0%3A1%3A4$/);
});

test("record announcements use the replay id supplied by the website API", async () => {
  const sent = [];
  const channel = { send: async message => sent.push(message) };
  await postEvent(channel, baseApi(), {
    kind: "record", steamId: "STEAM_0:1:1", playerName: "Runner", targetName: "Water route",
    valueMs: 12000, replayRunId: 12,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.description, /speedrun-replay\.html\?source=bootcamp&runId=12/);
  assert.match(sent[0].embeds[0].data.description, /Water route/);
});

test("personal best, tier and lesson events announce normalized website event fields", async () => {
  const sent = [];
  const channel = { send: async value => sent.push(value) };
  const api = baseApi();
  await postEvent(channel, api, { kind: "pb", steamId: "STEAM_0:1:1", playerName: "Runner", targetName: "Ramp", valueMs: 12000 });
  await postEvent(channel, api, { kind: "tier_up", steamId: "STEAM_0:1:1", playerName: "Runner", targetName: "Ramp", tier: 1 });
  await postEvent(channel, api, { kind: "lesson", steamId: "STEAM_0:1:1", playerName: "Runner", map: "2fort" });
  assert.equal(sent.length, 3);
  assert.match(sent[0], /personal best/i);
  assert.match(sent[1], /Bronze/);
  assert.match(sent[2], /completed.*lesson/i);
  assert.match(sent[2], /2fort/i);
});

test("license events publish the website's current authoritative license", async () => {
  const sent = [];
  const api = baseApi({ player: async () => ({ license: { level: "licensed", endorsements: ["offense"] } }) });
  await postEvent({ send: async value => sent.push(value) }, api, {
    kind: "license", steamId: "STEAM_0:1:1", playerName: "Runner",
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /TFC license/i);
  assert.match(sent[0], /Offense/);
});

test("failed delivery leaves the durable event cursor unchanged for retry", async () => {
  const settings = settingsStore({ "bootcamp:last_event_id": 10 });
  const api = baseApi({ events: async () => [{ id: 11, kind: "record", steamId: "STEAM_0:1:7", playerName: "runner", targetName: "Ramp", valueMs: 1000, replayRunId: 11 }] });
  const client = mockClient({ send: async () => { throw new Error("Discord send failed"); } });
  await pollBootcampEvents({ client, api, settings, steamLinks: { getDiscordBySteam: async () => [] }, logger: { error() {} } });
  assert.equal(settings.store.get("bootcamp:last_event_id"), 10);
});

test("successful event delivery advances the cursor before a later event fails", async () => {
  const settings = settingsStore({ "bootcamp:last_event_id": 10 });
  const events = [
    { id: 11, kind: "pb", steamId: "STEAM_0:1:7", playerName: "runner", targetName: "Route 1", valueMs: 1000 },
    { id: 12, kind: "pb", steamId: "STEAM_0:1:7", playerName: "runner", targetName: "Route 2", valueMs: 1000 },
  ];
  const api = baseApi({ events: async () => events });
  let sends = 0;
  const client = mockClient({ send: async () => { if (++sends === 2) throw new Error("Discord send failed"); } });
  await pollBootcampEvents({ client, api, settings, steamLinks: { getDiscordBySteam: async () => [] }, logger: { error() {} } });
  assert.equal(settings.store.get("bootcamp:last_event_id"), 11);
});

test("first poll starts at the latest API cursor instead of replaying history", async () => {
  const settings = settingsStore();
  let eventCalls = 0;
  const api = baseApi({ latestEventId: async () => 42, events: async () => { eventCalls++; return []; } });
  await pollBootcampEvents({ client: mockClient(), api, settings, logger: { error() {}, warn() {} } });
  assert.equal(settings.store.get("bootcamp:last_event_id"), 42);
  assert.equal(eventCalls, 0);
});

test("an initially empty feed processes the first event on the next poll", async () => {
  const settings = settingsStore();
  let latest = 0;
  const api = baseApi({ latestEventId: async () => latest, events: async after => {
    assert.equal(after, 0);
    latest = 1;
    return [{ id: 1, kind: "lesson", steamId: "STEAM_0:1:7", playerName: "runner", map: "2fort" }];
  } });
  const sent = [];
  const ctx = { client: mockClient({ send: async x => sent.push(x) }), api, settings,
    steamLinks: { getDiscordBySteam: async () => [] }, logger: { error() {}, warn() {} } };
  await pollBootcampEvents(ctx);
  await pollBootcampEvents(ctx);
  assert.equal(settings.store.get("bootcamp:last_event_id"), 1);
  assert.equal(sent.length, 1);
});

test("tier events recompute licenses through the website and then synchronize linked roles", async () => {
  const settings = settingsStore({ "bootcamp:last_event_id": 10 });
  let recomputed = 0;
  let queriedPlayer = 0;
  let added = 0;
  const member = { roles: { cache: new Set(), add: async () => { added++; }, remove: async () => {} } };
  const guild = { members: { fetch: async () => member } };
  const api = baseApi({
    events: async () => [{ id: 11, kind: "tier_up", steamId: "STEAM_0:1:7", playerName: "rookie", targetName: "Tour quiz", tier: 1 }],
    recomputeLicense: async () => { recomputed++; return { level: "permit", endorsements: [] }; },
    player: async () => { queriedPlayer++; return { license: { level: "permit", endorsements: [] } }; },
  });
  const ctx = { client: mockClient({ send: async () => {} }, new Map([["guild", guild]])), api, settings,
    steamLinks: {
      getDiscordBySteam: async () => [{ discord_id: "discord-user" }],
      getSteamIds: async () => [{ steam_id: "STEAM_0:1:7" }],
    }, logger: { error: e => { throw new Error(e); }, warn() {} } };
  process.env.BOOTCAMP_PERMIT_ROLE_ID = "permit-role";
  try {
    await pollBootcampEvents(ctx);
    assert.equal(settings.store.get("bootcamp:last_event_id"), 11);
    assert.equal(recomputed, 1);
    assert.equal(queriedPlayer, 1);
    assert.equal(added, 1);
  } finally {
    delete process.env.BOOTCAMP_PERMIT_ROLE_ID;
  }
});

test("license roles remain unchanged if account linking is unavailable", async () => {
  process.env.BOOTCAMP_LICENSED_ROLE_ID = "licensed";
  let removed = 0;
  const member = { roles: { cache: new Set(["licensed"]), remove: async () => { removed++; } } };
  const ctx = { client: mockClient(null, new Map([["guild", { members: { fetch: async () => member } }]])),
    api: baseApi(), config: {}, logger: {}, steamLinks: { getSteamIds: async () => { throw new Error("link store unavailable"); } } };
  try {
    await assert.rejects(syncMemberRoles(ctx, "user"), /link store unavailable/);
    assert.equal(removed, 0);
  } finally { delete process.env.BOOTCAMP_LICENSED_ROLE_ID; }
});

test("queue gate stays open unless a required role is explicitly configured", () => {
  const member = roles => ({ roles: { cache: new Set(roles) } });
  assert.equal(canJoinQueue(member([]), { roles: {} }), true);
  const config = { roles: { queueRequired: "lic", admin: "adm" } };
  assert.equal(canJoinQueue(member([]), config), false);
  assert.equal(canJoinQueue(member(["lic"]), config), true);
  assert.equal(canJoinQueue(member(["adm"]), config), true);
});
