"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { OWNER_ID, execute } = require("../commands/selfdestruct");

function messageFor(id) {
  const replies = [];
  const sentMessages = [];
  return {
    author: { id },
    reply: async (content) => {
      replies.push(content);
      const sentMessage = {
        edits: [],
        edit: async (nextContent) => sentMessage.edits.push(nextContent),
      };
      sentMessages.push(sentMessage);
      return sentMessage;
    },
    replies,
    sentMessages,
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

  assert.deepEqual(message.replies, ["⚠️ **CRITICAL COMMAND ACCEPTED**"]);
  assert.deepEqual(message.sentMessages[0].edits, [
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████░░░░░░░░░░░░░░░░] 20%`",
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████████░░░░░░░░░░░░] 40%`\n🛰 Simulating Discord relay shutdown...",
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████████████░░░░░░░░] 60%`\n🛰 Simulating Discord relay shutdown...\n🗄 Pretending to delete absolutely nothing...",
    "⚠️ **FINAL WARNING**\nCancellation window closes in 3 seconds.\n\n💥 3... 2... 1...",
    "😎 **SELF-DESTRUCT CANCELED**\n\nYou got pranked. Nothing was changed. Probably.",
  ]);
});

test("selfdestruct registers under its command name", () => {
  const registry = new Map();

  require("../commands/selfdestruct").register(registry);

  assert.equal(typeof registry.get("selfdestruct"), "function");
});
