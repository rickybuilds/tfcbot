"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { EloDB } = require("../lib/elo");
const { register } = require("../commands/rule8");

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfcbot-rule8-"));
  return {
    dir,
    file: path.join(dir, "elo.db"),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function roleCollection(entries) {
  const map = new Map(entries);
  map.filter = predicate => roleCollection([...map].filter(([id, role]) => predicate(role, id)));
  return map;
}

test("Rule 8 transfers one Elo and persists the target infraction count", () => {
  const tmp = tempDb();
  const elo = new EloDB(tmp.file);

  try {
    elo.setRatingAdmin("target", 2000, "Target");
    elo.setRatingAdmin("issuer", 1800, "Issuer");

    const first = elo.recordRule8Infraction("target", "issuer");
    assert.equal(first.count, 1);
    assert.equal(elo.peekRating("target"), 1999);
    assert.equal(elo.peekRating("issuer"), 1801);

    const reopened = new EloDB(tmp.file);
    assert.equal(reopened.getRule8InfractionCount("target"), 1);
    assert.equal(reopened.peekRating("target"), 1999);
    const cleared = reopened.clearLatestRule8Infraction("target");
    assert.equal(cleared.reversedElo, true);
    assert.equal(reopened.getRule8InfractionCount("target"), 0);
    assert.equal(reopened.peekRating("target"), 2000);
    assert.equal(reopened.peekRating("issuer"), 1800);
    reopened.db.close();
  } finally {
    if (elo.db.open) elo.db.close();
    tmp.cleanup();
  }
});

test("Rule 8 command jails at five infractions and escalates by 24 hours", async () => {
  const previousAdminRole = process.env.ADMIN_ROLE_ID;
  process.env.ADMIN_ROLE_ID = "admin-role";
  const tmp = tempDb();
  const elo = new EloDB(tmp.file);
  const registry = new Map();
  const sent = [];
  const jailCalls = [];
  const target = {
    id: "target",
    roles: {
      cache: roleCollection([["old-role", { id: "old-role", name: "Player" }]]),
      async remove() {},
      async add() {},
    },
  };
  const issuer = {
    id: "issuer",
    roles: { cache: roleCollection([["admin-role", { id: "admin-role" }]]) },
  };
  const message = {
    author: { id: "issuer" },
    member: issuer,
    mentions: { users: { first: () => ({ id: "target", username: "Target" }) }, members: { first: () => target } },
    channel: { async send(value) { sent.push(value); } },
  };
  const jailStore = {
    records: new Map(),
    get(id) { return this.records.get(id) || null; },
    set(id, value) { this.records.set(id, value); jailCalls.push({ id, value }); },
  };

  try {
    register(registry, { elo, jailStore, config: { roles: { jail: "jail-role" } } });
    for (let i = 0; i < 5; i++) await registry.get("rule8")(message, []);

    assert.equal(elo.getRule8InfractionCount("target"), 5);
    assert.equal(jailCalls.length, 1);
    assert.ok(jailCalls[0].value.expires - Date.now() > 23 * 60 * 60 * 1000);
    assert.match(sent.at(-1), /24 hours/);

    await registry.get("rule8")(message, []);
    assert.equal(elo.getRule8InfractionCount("target"), 6);
    assert.equal(jailCalls.length, 1, "only threshold multiples trigger a new jail");

    for (let i = 0; i < 4; i++) await registry.get("rule8")(message, []);
    assert.equal(elo.getRule8InfractionCount("target"), 10);
    assert.equal(jailCalls.length, 2);
    assert.ok(jailCalls.at(-1).value.expires - Date.now() > 71 * 60 * 60 * 1000);
    assert.match(sent.at(-1), /48 hours/);
  } finally {
    if (previousAdminRole === undefined) delete process.env.ADMIN_ROLE_ID;
    else process.env.ADMIN_ROLE_ID = previousAdminRole;
    if (elo.db.open) elo.db.close();
    tmp.cleanup();
  }
});

test("bare Rule 8 command displays the rule text", async () => {
  const previousAdminRole = process.env.ADMIN_ROLE_ID;
  process.env.ADMIN_ROLE_ID = "admin-role";
  const posted = [];
  const registry = new Map();
  const message = {
    author: { id: "issuer" },
    member: { roles: { cache: roleCollection() } },
    mentions: { users: { first: () => null }, members: { first: () => null } },
    channel: { async send(value) { posted.push(value); } },
  };

  try {
    register(registry, { elo: null, jailStore: null, config: { roles: {} } });
    await registry.get("rule8")(message, []);
    assert.match(posted[0], /Rule 8 — Have Fun/);
    assert.match(posted[0], /play, improve, and enjoy the game together/);
    assert.match(posted[0], /!rule8 @user/);
  } finally {
    if (previousAdminRole === undefined) delete process.env.ADMIN_ROLE_ID;
    else process.env.ADMIN_ROLE_ID = previousAdminRole;
  }
});

test("Rule 8 clear refunds the latest Elo transfer and threshold jail", async () => {
  const previousAdminRole = process.env.ADMIN_ROLE_ID;
  process.env.ADMIN_ROLE_ID = "admin-role";
  const posted = [];
  const registry = new Map();
  let cleared;
  const message = {
    author: { id: "issuer" },
    member: { roles: { cache: roleCollection([["admin-role", { id: "admin-role" }]]) } },
    mentions: {
      users: { first: () => ({ id: "target" }) },
      members: {
        first: () => ({
          id: "target",
          guild: { roles: { cache: new Map([["old-role", { id: "old-role" }]]) } },
          roles: { cache: new Map([["jail-role", { id: "jail-role" }]]), async remove() {}, async add() {} },
        }),
      },
    },
    channel: { async send(value) { posted.push(value); } },
  };

  try {
    register(registry, {
      elo: {
        clearLatestRule8Infraction(id) {
          cleared = id;
          return { cleared: true, count: 4, reversedElo: true, releaseJail: true };
        },
      },
      jailStore: {
        get() { return { oldRoles: ["old-role"], expires: Date.now() + 1000 }; },
        delete() { cleared = `${cleared}:unjail`; },
      },
      config: { roles: { jail: "jail-role" } },
    });
    await registry.get("rule8clear")(message, []);
    assert.equal(cleared, "target:unjail");
    assert.match(posted[0], /cleared the most recent/);
    assert.match(posted[0], /refunded 1 Elo/);
    assert.match(posted[0], /jail was also cleared/);
  } finally {
    if (previousAdminRole === undefined) delete process.env.ADMIN_ROLE_ID;
    else process.env.ADMIN_ROLE_ID = previousAdminRole;
  }
});
