"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recomputeLicense,
  rolesForLicense,
  licenseRoleIds,
  pollBootcampEvents,
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
  const client = { channels: { fetch: async () => null, cache: { find: () => null } }, guilds: { cache: new Map() } };
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
