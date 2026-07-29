"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startVote } = require("../lib/vote");

test("a direct server winner reaches onFinish even if its announcement stalls", async () => {
  const collector = new EventEmitter();
  collector.stop = reason => collector.emit("end", new Map(), reason);

  const voteMessage = {
    components: [],
    edit: async () => voteMessage,
    createMessageComponentCollector: () => collector,
    reply: async () => ({}),
  };

  let sendCount = 0;
  const message = {
    channel: {
      send: async () => {
        sendCount += 1;
        if (sendCount === 1) return voteMessage;
        if (sendCount === 2) return {};
        return new Promise(() => {});
      },
    },
  };

  const state = {
    MAX_BUTTONS: 5,
    MAX_PLAYERS: 2,
    queue: [],
    queueSnapshot: [
      { id: "111111111111111111", name: "One" },
      { id: "222222222222222222", name: "Two" },
    ],
  };

  let finish;
  const finished = new Promise(resolve => {
    finish = resolve;
  });

  await startVote(state, message, {
    title: "Server Vote",
    duration: 10,
    kind: "server",
    options: [
      { id: "1", name: "East", ref: { name: "East" } },
      { id: "2", name: "West", ref: { name: "West" } },
    ],
    onFinish: finish,
  });

  state.vote.counts.set("1", 2);
  state.vote.votedByUser.set("111111111111111111", "1");
  state.vote.votedByUser.set("222222222222222222", "1");
  collector.stop("test");

  const payload = await Promise.race([
    finished,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("server vote did not reach onFinish")), 250);
    }),
  ]);

  assert.equal(payload.winner.name, "East");
  assert.equal(state.vote, null);
});
