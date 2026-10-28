"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { state } = require("../lib/state");

async function fixture(t, { admin = true, expires = Date.now() + 86400000 } = {}) {
  const previous = process.env.ADMIN_ROLE_ID;
  const previousBans = state.bannedUsers;
  state.bannedUsers = new Set();
  process.env.ADMIN_ROLE_ID = "admin";
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_ROLE_ID;
    else process.env.ADMIN_ROLE_ID = previous;
    state.bannedUsers = previousBans;
  });
  const registry = new Map();
  const original = { expires, oldRoles: ["player"], reason: "original offence", admin: "original-admin" };
  const store = new Map([["target", original]]);
  const sent = [], audit = [];
  const roles = new Map([["jail", { id: "jail" }]]);
  const target = {
    id: "target",
    guild: { roles: { cache: new Map([["player", { id: "player" }]]) } },
    roles: {
      cache: roles,
      async remove(id) { roles.delete(id); },
      async add(role) { roles.set(role.id, role); },
    },
  };
  const message = {
    author: { id: "moderator" },
    member: { roles: { cache: new Map(admin ? [["admin", {}]] : []) } },
    mentions: { members: { first: () => target } },
    channel: { async send(value) { sent.push(value); } },
    client: { channels: { async fetch() { return { isTextBased: () => true, async send(value) { audit.push(value); } }; } } },
  };
  const command = require("../commands/reducejail");
  await command.register(registry, { jailStore: store, config: { roles: { jail: "jail" }, channels: { audit: "audit" } } });
  return { run: (args = ["<@target>", "6h", "good", "behaviour"]) => registry.get("reducejail")(message, args), store, original, roles, sent, audit, message, target };
}

test("reduces the existing expiry, preserves jail metadata and roles, and audits the reason", async t => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(f.store.get("target"), { ...f.original, expires: f.original.expires - 21600000 });
  assert.deepEqual([...f.roles.keys()], ["jail"]);
  assert.match(f.sent.join(" "), /<t:\d+:F>/);
  assert.match(f.audit.join(" "), /moderator.*target.*6h.*good behaviour/s);
});

for (const duration of ["0h", "-2h", "nonsense", "Infinity", "999999999999999999999999999999999h"]) {
  test(`rejects invalid reduction ${duration} without changing the sentence`, async t => {
    const f = await fixture(t);
    await f.run(["<@target>", duration, "good behaviour"]);
    assert.equal(f.store.get("target"), f.original);
    assert.equal(f.audit.length, 0);
    assert.match(f.sent.join(" "), /duration/i);
  });
}

test("requires a mention and a reason", async t => {
  const f = await fixture(t);
  await f.run(["<@target>", "6h"]);
  f.message.mentions.members.first = () => undefined;
  await f.run();
  assert.equal(f.store.get("target"), f.original);
  assert.equal(f.sent.length, 2);
  assert.equal(f.audit.length, 0);
});

test("non-admins cannot reduce sentences", async t => {
  const f = await fixture(t, { admin: false });
  await f.run();
  assert.equal(f.store.get("target"), f.original);
  assert.equal(f.sent.length, 0);
  assert.equal(f.audit.length, 0);
});

test("reports a player who is not jailed", async t => {
  const f = await fixture(t);
  f.store.clear();
  await f.run();
  assert.match(f.sent.join(" "), /not.*jail/i);
  assert.equal(f.audit.length, 0);
});

test("indefinite sentences cannot be reduced", async t => {
  const f = await fixture(t, { expires: 32503680000000 });
  await f.run();
  assert.equal(f.store.get("target"), f.original);
  assert.match(f.sent.join(" "), /indefinite.*!unjail/i);
});

test("a reduction covering remaining time immediately restores roles and clears the jail and queue ban", async t => {
  const f = await fixture(t, { expires: Date.now() + 3600000 });
  state.bannedUsers.add("target");
  await f.run();
  assert.equal(f.store.has("target"), false);
  assert.equal(f.roles.has("jail"), false);
  assert.equal(f.roles.has("player"), true);
  assert.equal(state.bannedUsers.has("target"), false);
  assert.match(f.sent.join(" "), /released/i);
  assert.match(f.audit.join(" "), /good behaviour.*released/is);
});

test("failed role restoration retains the jail record for retry and reports failure", async t => {
  const f = await fixture(t, { expires: Date.now() + 3600000 });
  f.target.roles.add = async () => { throw new Error("Missing permissions"); };
  const previous = console.error;
  console.error = () => {};
  t.after(() => { console.error = previous; });
  await f.run();
  assert.equal(f.store.has("target"), true);
  assert.match(f.sent.join(" "), /failed/i);
  assert.equal(f.audit.length, 0);
});
