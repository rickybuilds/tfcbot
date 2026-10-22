"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { OWNER_ID, execute } = require("../commands/selfdestruct");

function messageFor(id) {
  const replies = [];
  return {
    author: { id },
    reply: async (content) => replies.push(content),
    replies,
  };
}

test("selfdestruct only runs for the configured owner", async () => {
  const message = messageFor("not-the-owner");

  await execute(message, [], { delayMs: 0 });

  assert.deepEqual(message.replies, ["🚫 Nice try — `!selfdestruct` is owner-only."]);
});

test("selfdestruct performs a harmless fake countdown for the owner", async () => {
  const message = messageFor(OWNER_ID);

  await execute(message, [], { delayMs: 0 });

  assert.deepEqual(message.replies, [
    "⚠️ SELF-DESTRUCT SEQUENCE INITIATED...",
    "💥 3... 2... 1...",
    "😎 Self-destruct canceled. You got pranked.",
  ]);
});

test("selfdestruct registers under its command name", () => {
  const registry = new Map();

  require("../commands/selfdestruct").register(registry);

  assert.equal(typeof registry.get("selfdestruct"), "function");
});
