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

  await execute(message, [], { delayMs: 0, finalDelayMs: 0 });

  assert.deepEqual(message.replies, ["⚠️ **NONAMEPUGS SHUTDOWN PROTOCOL**"]);
  const edits = message.sentMessages[0].edits;
  assert.match(edits[0], /Loading nonamepugs\.\.\.[\s\S]*Progress: .* 7%$/);
  assert.match(edits[2], /Loading nonamepugs-website\.\.\.[\s\S]*Progress: .* 20%$/);
  assert.match(edits[edits.length - 3], /Progress: .* 100%$/);
  assert.equal(edits[edits.length - 2], "⚠️ **THIS IS GOODBYE.**\n\nThe server will be missed.");
  assert.equal(edits[edits.length - 1], "😎 **Never mind.**\n\nYou got pranked. Nothing was changed.");
});

test("selfdestruct registers under its command name", () => {
  const registry = new Map();

  require("../commands/selfdestruct").register(registry);

  assert.equal(typeof registry.get("selfdestruct"), "function");
});
