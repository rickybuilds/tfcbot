"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { enforcePickupMuteMessage } = require("../lib/pickupMuteMessages");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muted-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "mutedlogs.json");
}
function message(content) {
  return { id: "m1", guild: { id: "g1", name: "Guild" }, channel: { id: "c1", name: "pickup" }, author: { id: "u1", username: "Alice", bot: false }, content, createdAt: new Date("2026-11-08T12:00:00Z"), delete: async function () { this.deleted = true; } };
}
const muted = new Set(["u1"]);
test("records blocked messages and edits with their text and context", async t => {
  const file = setup(t);
  const first = message("first message");
  const edited = message("edited message");
  await enforcePickupMuteMessage(first, muted, file);
  await enforcePickupMuteMessage(edited, muted, file);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(entries.map(e => e.content), ["first message", "edited message"]);
  assert.equal(entries[0].userId, "u1");
  assert.equal(entries[0].username, "Alice");
  assert.equal(entries[0].guildId, "g1");
  assert.equal(entries[0].channelId, "c1");
  assert.equal(entries[0].messageId, "m1");
  assert.ok(!Number.isNaN(Date.parse(entries[0].timestamp)));
  assert.equal(first.deleted, true);
  assert.equal(edited.deleted, true);
});
test("allows whitelisted messages and ignores unmuted users and DMs", async t => {
  const file = setup(t);
  for (const item of [message(" !ADD "), { ...message("hello"), author: { id: "other" } }, { ...message("hello"), guild: null }]) {
    assert.equal(await enforcePickupMuteMessage(item, muted, file), false);
    assert.equal(item.deleted, undefined);
  }
  assert.equal(fs.existsSync(file), false);
});
test("still deletes when the existing log is invalid without overwriting it", async t => {
  const file = setup(t);
  fs.writeFileSync(file, "invalid json");
  const item = message("blocked");
  assert.equal(await enforcePickupMuteMessage(item, muted, file), true);
  assert.equal(item.deleted, true);
  assert.equal(fs.readFileSync(file, "utf8"), "invalid json");
});
