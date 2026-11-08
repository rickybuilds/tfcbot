"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recomputeLicense,
  rolesForLicense,
  licenseRoleIds,
  pollBootcampEvents,
  syncMemberRoles,
  postEvent,
  playerUrl,
} = require("../services/bootcampWatcher");
const { canJoinQueue } = require("../lib/queueGate");

// Minimal mysql2-style pool: routes each query to a handler by its first match.
function fakePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const [pattern, fn] of handlers) {
        if (pattern.test(sql)) return [await fn(sql, params)];
      }
      return [[]];
    },
  };
}

const catalogue = {
  drills: [{ id: 1, map: "openfire", slug: "tour_quiz", class_id: 0 }],
  routes: [],
  rotation: [{ map: "openfire", rotation_order: 0 }],
};

test("player profile links target the existing query-driven Bootcamp hub", () => {
  assert.match(playerUrl("STEAM_0:1:4"), /\/bootcamp\.html\?steamid=STEAM_0%3A1%3A4$/);
});

test("recomputeLicense stores a new permit and reports the change", async () => {
  const pool = fakePool([
    [/FROM bootcamp_tiers/, () => [{ target_type: "drill", target_id: 1, class_id: 3, tier: 1 }]],
    [/FROM bootcamp_licenses/, () => []],
    [/INSERT INTO bootcamp_licenses/, () => ({ affectedRows: 1 })],
  ]);
  const result = await recomputeLicense(pool, "STEAM_0:1:1", catalogue);
  assert.equal(result.changed, true);
  assert.equal(result.next.level, "permit");
  const insert = pool.calls.find(c => /INSERT INTO bootcamp_licenses/.test(c.sql));
  assert.deepEqual(insert.params.slice(0, 3), ["STEAM_0:1:1", "permit", ""]);
});

test("recomputeLicense leaves an unchanged license alone", async () => {
  const pool = fakePool([
    [/FROM bootcamp_tiers/, () => [{ target_type: "drill", target_id: 1, class_id: 3, tier: 1 }]],
    [/FROM bootcamp_licenses/, () => [{ level: "permit", endorsements: "" }]],
  ]);
  const result = await recomputeLicense(pool, "STEAM_0:1:1", catalogue);
  assert.equal(result.changed, false);
  assert.ok(!pool.calls.some(c => /INSERT INTO bootcamp_licenses/.test(c.sql)));
});

test("license roles stack: platinum keeps the licensed and permit roles", () => {
  const roleIds = { permit: "p", licensed: "l", platinum: "x", offense: "o", "class:engineer": "e" };
  const roles = rolesForLicense({ level: "platinum", endorsements: ["offense", "class:engineer"] }, roleIds);
  assert.deepEqual([...roles].sort(), ["e", "l", "o", "p", "x"]);
  assert.deepEqual([...rolesForLicense({ level: "none", endorsements: [] }, roleIds)], []);
});

test("personal bests and bronze tier-ups produce progress notifications", async () => {
  const sent = [];
  const channel = { send: async message => sent.push(message) };
  const pool = fakePool([[/SELECT name, map FROM bootcamp_routes/, () => [{ name: "Water", map: "openfire" }]]]);
  await postEvent(channel, pool, { kind: "pb", steamid: "STEAM_0:1:1", player_name: "Runner", target_type: "route", target_id: 4, value_ms: 12000 });
  await postEvent(channel, pool, { kind: "tier_up", steamid: "STEAM_0:1:1", player_name: "Runner", target_type: "route", target_id: 4, tier: 1 });
  assert.equal(sent.length, 2);
  assert.match(String(sent[0]), /personal best/i);
  assert.match(String(sent[1]), /bronze/i);
});

test("record announcements link to the Bootcamp replay API", async () => {
  const sent = [];
  const channel = { send: async message => sent.push(message) };
  const pool = fakePool([
    [/SELECT id FROM bootcamp_runs/, () => [{ id: 12 }]],
    [/SELECT name, map FROM bootcamp_routes/, () => [{ name: "Water", map: "openfire" }]],
  ]);
  await postEvent(channel, pool, {
    kind: "record", steamid: "STEAM_0:1:1", player_name: "Runner", target_type: "route",
    target_id: 4, value_ms: 12000,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.description, /speedrun-replay\.html\?source=bootcamp&runId=12/);
});

test("failed record delivery leaves the event cursor for retry", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([
    [/FROM bootcamp_events WHERE id > \?/, () => [{ id: 11, kind: "record", steamid: "STEAM_0:1:7", player_name: "runner", target_type: "route", target_id: 1, value_ms: 1000 }]],
    [/SELECT id FROM bootcamp_runs/, () => [{ id: 11 }]],
    [/SELECT name, map FROM bootcamp_routes/, () => [{ name: "Ramp", map: "openfire" }]],
  ]);
  const channel = { send: async () => { throw new Error("Discord send failed"); } };
  const client = { channels: { fetch: async () => null, cache: { find: () => channel } } };
  await pollBootcampEvents({ client, pool, settings, steamLinks: { getDiscordBySteam: async () => [] }, logger: { error() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 10);
});

test("successful events advance the durable cursor before a later event fails", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([
    [/FROM bootcamp_events WHERE id > \?/, () => [11, 12].filter(id => id > (store.get("bootcamp:last_event_id") || 0)).map(id => ({ id, kind: "pb", steamid: "STEAM_0:1:7", player_name: "runner", target_type: "route", target_id: id, value_ms: 1000 }))],
    [/SELECT name, map FROM bootcamp_routes/, (_sql, [id]) => [{ name: `Route ${id}`, map: "openfire" }]],
  ]);
  let sends = 0;
  const channel = { send: async () => { if (++sends === 2) throw new Error("Discord send failed"); } };
  const client = { channels: { fetch: async () => null, cache: { find: () => channel } } };
  await pollBootcampEvents({ client, pool, settings, steamLinks: { getDiscordBySteam: async () => [] }, logger: { error() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 11);
});

test("lesson completion events announce the achievement", async () => {
  const sent = [];
  const channel = { send: async message => sent.push(message) };
  await postEvent(channel, fakePool([]), { kind: "lesson", steamid: "STEAM_0:1:1", player_name: "Runner", map: "2fort" });
  assert.equal(sent.length, 1);
  assert.match(String(sent[0]), /completed.*lesson/i);
  assert.match(String(sent[0]), /2fort/i);
});

test("license role ids come from the environment and reuse the offense role", () => {
  process.env.BOOTCAMP_LICENSED_ROLE_ID = "111";
  process.env.BOOTCAMP_ENGINEER_ROLE_ID = "222";
  const ids = licenseRoleIds({ roles: { offense: "333" } });
  assert.equal(ids.licensed, "111");
  assert.equal(ids["class:engineer"], "222");
  assert.equal(ids.offense, "333");
  delete process.env.BOOTCAMP_LICENSED_ROLE_ID;
  delete process.env.BOOTCAMP_ENGINEER_ROLE_ID;
});

test("issued license roles include custom queue and offense endorsement roles", () => {
  const prior = Object.fromEntries(["BOOTCAMP_LICENSED_ROLE_ID", "BOOTCAMP_PLATINUM_ROLE_ID"].map(key => [key, process.env[key]]));
  process.env.BOOTCAMP_LICENSED_ROLE_ID = "licensed";
  delete process.env.BOOTCAMP_PLATINUM_ROLE_ID;
  try {
    const ids = licenseRoleIds({ roles: {
      queueRequired: "queue-required",
      offense: "legacy-offense",
      bootcampOffense: "bootcamp-offense",
    } });
    const licensed = rolesForLicense({ level: "licensed", endorsements: [] }, ids);
    assert.equal(licensed.has("licensed"), true);
    assert.equal(licensed.has("queue-required"), true);
    assert.equal(licensed.has("legacy-offense"), false);

    const endorsed = rolesForLicense({ level: "licensed", endorsements: ["offense"] }, ids);
    assert.equal(endorsed.has("legacy-offense"), true);
    assert.equal(endorsed.has("bootcamp-offense"), true);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("a Steam link lookup failure does not revoke license roles", async () => {
  const original = process.env.BOOTCAMP_LICENSED_ROLE_ID;
  process.env.BOOTCAMP_LICENSED_ROLE_ID = "licensed";
  let removed = 0;
  const member = { roles: { cache: new Set(["licensed"]), remove: async () => { removed++; } } };
  const guild = { members: { fetch: async () => member } };
  const ctx = { client: { guilds: { cache: new Map([["guild", guild]]) } }, pool: {}, config: {}, logger: {}, steamLinks: { getSteamIds: async () => { throw new Error("link store unavailable"); } } };
  try {
    await assert.rejects(syncMemberRoles(ctx, "user"), /link store unavailable/);
    assert.equal(removed, 0);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LICENSED_ROLE_ID;
    else process.env.BOOTCAMP_LICENSED_ROLE_ID = original;
  }
});

test("role synchronization retries transient member lookup failures but skips unknown members", async () => {
  const original = process.env.BOOTCAMP_LICENSED_ROLE_ID;
  process.env.BOOTCAMP_LICENSED_ROLE_ID = "licensed";
  const guild = { members: { fetch: async () => { throw new Error("Discord unavailable"); } } };
  const ctx = { client: { guilds: { cache: new Map([["guild", guild]]) } }, pool: fakePool([]), config: {}, logger: {}, steamLinks: { getSteamIds: async () => [] } };
  try {
    await assert.rejects(syncMemberRoles(ctx, "user"), /Discord unavailable/);
    guild.members.fetch = async () => { const error = new Error("Unknown Member"); error.code = 10007; throw error; };
    await assert.doesNotReject(syncMemberRoles(ctx, "user"));
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LICENSED_ROLE_ID;
    else process.env.BOOTCAMP_LICENSED_ROLE_ID = original;
  }
});

test("the first poll starts at the end of the feed instead of replaying history", async () => {
  const store = new Map();
  const settings = {
    getNumber: (k, fb) => (store.has(k) ? store.get(k) : fb),
    setNumber: (k, v) => store.set(k, v),
  };
  const pool = fakePool([[/MAX\(id\)/, () => [{ id: 42 }]]]);
  await pollBootcampEvents({ client: {}, pool, settings, logger: { error() {}, warn() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 42);
  assert.ok(!pool.calls.some(c => /WHERE id > \?/.test(c.sql)));
});

test("license events advance the cursor even when no other events follow", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([
    [/FROM bootcamp_events WHERE id > \?/, () => [{ id: 11, kind: "license" }]],
  ]);
  const client = { channels: { cache: { find: () => ({ send: async () => {} }) } } };
  await pollBootcampEvents({ client, pool, settings, logger: { error() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 11);
});

test("an initially empty feed processes the first event on the next poll", async () => {
  const store = new Map();
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([
    [/MAX\(id\)/, () => [{ id: 0 }]],
    [/FROM bootcamp_events WHERE id > \?/, () => [{ id: 1, kind: "license" }]],
  ]);
  const client = { channels: { cache: { find: () => ({ send: async () => {} }) } } };
  await pollBootcampEvents({ client, pool, settings, logger: { error() {} } });
  await pollBootcampEvents({ client, pool, settings, logger: { error() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 1);
});

test("a link lookup failure keeps the event cursor for retry", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([
    [/FROM bootcamp_events WHERE id > \?/, () => [{ id: 11, kind: "tier_up", steamid: "STEAM_0:1:7", target_type: "drill", target_id: 1, tier: 1 }]],
    [/FROM bootcamp_drills/, () => catalogue.drills],
    [/FROM bootcamp_maps/, () => catalogue.rotation],
    [/FROM bootcamp_tiers/, () => [{ target_type: "drill", target_id: 1, class_id: 3, tier: 1 }]],
  ]);
  const client = { channels: { cache: { find: () => null } } };
  const steamLinks = { getDiscordBySteam: async () => { throw new Error("offline"); } };
  await pollBootcampEvents({ client, pool, settings, steamLinks, logger: { error() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 10);
});

test("missing notification channel leaves publishable events queued", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = { getNumber: (key, fallback) => store.has(key) ? store.get(key) : fallback, setNumber: (key, value) => store.set(key, value) };
  const pool = fakePool([[/FROM bootcamp_events WHERE id > \?/, () => [{ id: 11, kind: "lesson", steamid: "STEAM_0:1:7", player_name: "runner", map: "2fort" }]]]);
  const client = { channels: { cache: { find: () => null } } };
  await pollBootcampEvents({ client, pool, settings, logger: { error() {}, warn() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 10);
});

test("a tier-up recomputes the license and advances the feed", async () => {
  const store = new Map([["bootcamp:last_event_id", 10]]);
  const settings = {
    getNumber: (k, fb) => (store.has(k) ? store.get(k) : fb),
    setNumber: (k, v) => store.set(k, v),
  };
  const pool = fakePool([
    [/FROM bootcamp_events WHERE id > \?/, () => [
      { id: 11, kind: "tier_up", steamid: "STEAM_0:1:7", player_name: "rookie", target_type: "drill", target_id: 1, tier: 1 },
    ]],
    [/FROM bootcamp_drills/, () => catalogue.drills],
    [/FROM bootcamp_routes/, () => catalogue.routes],
    [/FROM bootcamp_maps/, () => catalogue.rotation],
    [/FROM bootcamp_tiers/, () => [{ target_type: "drill", target_id: 1, class_id: 3, tier: 1 }]],
    [/FROM bootcamp_licenses/, () => []],
  ]);
  const client = { channels: { fetch: async () => null, cache: { find: () => ({ send: async () => {} }) } }, guilds: { cache: new Map() } };
  const steamLinks = { getDiscordBySteam: async () => [] };
  await pollBootcampEvents({ client, pool, settings, steamLinks, logger: { error: e => { throw new Error(e); }, warn() {} } });
  assert.equal(store.get("bootcamp:last_event_id"), 11);
  assert.ok(pool.calls.some(c => /INSERT INTO bootcamp_licenses/.test(c.sql)));
  assert.ok(pool.calls.some(c => /VALUES \('license'/.test(c.sql)));
});

test("queue gate is open without a configured role and checks the role when set", () => {
  const member = roles => ({ roles: { cache: new Set(roles) } });
  assert.equal(canJoinQueue(member([]), { roles: {} }), true);
  const config = { roles: { queueRequired: "lic", admin: "adm" } };
  assert.equal(canJoinQueue(member([]), config), false);
  assert.equal(canJoinQueue(member(["lic"]), config), true);
  assert.equal(canJoinQueue(member(["adm"]), config), true);
  assert.equal(canJoinQueue(null, config), false);
});
