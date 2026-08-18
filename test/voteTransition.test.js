"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { startVote, getMapVoteShortenReason } = require("../lib/vote");

const ids = Array.from(
  { length: 8 },
  (_, i) => `${String(i + 1).padStart(2, "0")}1111111111111111`
);

test("map vote shortening recognizes a majority among the frozen queue", () => {
  const options = [
    { id: "1", name: "openfire" },
    { id: "N", name: "New Maps" },
  ];
  const reason = getMapVoteShortenReason({
    eligible: ids,
    voted: new Set(ids.slice(0, 5)),
    counts: new Map([["1", 5], ["N", 0]]),
    options,
  });

  assert.equal(reason.type, "majority");
  assert.deepEqual(reason.options.map(option => option.name), ["openfire"]);
  assert.deepEqual(reason.realEligible, ids);
});

test("map vote shortening recognizes one remaining voter without a majority", () => {
  const options = [
    { id: "1", name: "openfire" },
    { id: "2", name: "well" },
    { id: "N", name: "New Maps" },
  ];
  const reason = getMapVoteShortenReason({
    eligible: ids,
    voted: new Set(ids.slice(0, 7)),
    counts: new Map([["1", 3], ["2", 2], ["N", 2]]),
    options,
  });

  assert.equal(reason.type, "one_remaining");
  assert.equal(reason.waiting.length, 1);
});

test("map vote shortening does not trigger with multiple voters remaining and no majority", () => {
  const reason = getMapVoteShortenReason({
    eligible: ids,
    voted: new Set(ids.slice(0, 6)),
    counts: new Map([["1", 2], ["2", 2], ["N", 2]]),
    options: [
      { id: "1", name: "openfire" },
      { id: "2", name: "well" },
      { id: "N", name: "New Maps" },
    ],
  });

  assert.equal(reason, null);
});

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

test("vote voter labels use the stored player name instead of the Discord view name", async () => {
  const collector = new EventEmitter();
  collector.stop = reason => collector.emit("end", new Map(), reason);

  const edits = [];
  const voteMessage = {
    components: [],
    edit: async payload => {
      edits.push(payload);
      return voteMessage;
    },
    createMessageComponentCollector: () => collector,
    reply: async () => ({}),
  };

  const message = {
    channel: { send: async () => voteMessage },
  };
  const state = {
    MAX_BUTTONS: 5,
    MAX_PLAYERS: 1,
    queue: [],
    queueSnapshot: [{ id: "111111111111111111", name: "Queue Name" }],
  };
  const elo = {
    getDisplayName: () => "Stored Name",
  };

  await startVote(state, message, {
    title: "Server Vote",
    duration: 10,
    kind: "server",
    showVoters: true,
    elo,
    options: [{ id: "1", name: "East" }],
  });

  collector.emit("collect", {
    user: { id: "111111111111111111", username: "Discord Username" },
    member: { displayName: "Discord View Name" },
    customId: "vote_1",
    deferUpdate: async () => {},
  });

  await new Promise(resolve => setImmediate(resolve));
  const description = edits.at(-1).embeds[0].data.description;
  assert.match(description, /Stored Name/);
  assert.doesNotMatch(description, /Discord View Name/);

  collector.stop("test");
});
