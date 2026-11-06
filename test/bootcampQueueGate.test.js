"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { canJoinQueue } = require("../lib/queueGate");

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
