"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PICK_ORDER, captainIds, isCaptainMode, pickOrderFor } = require("../lib/captains");
const { finalizeMatch } = require("../commands/voteFlow");
const {
  buildSubstitutionScenarios,
  replaceCaptainId,
} = require("../commands/sub");

test("captain mode activates only with exactly two captains", () => {
  const players = [
    { id: "1", captain: true },
    { id: "2", captain: true },
    { id: "3" },
  ];
  assert.deepEqual(captainIds(players), ["1", "2"]);
  assert.equal(isCaptainMode(players), true);
  assert.equal(isCaptainMode(players.slice(0, 1)), false);
});

test("six-player draft uses the fixed Team 1/Team 2 order", () => {
  assert.deepEqual(PICK_ORDER, ["blue", "red", "blue", "red", "red", "blue"]);
  assert.equal(PICK_ORDER.filter(team => team === "blue").length, 3);
  assert.equal(PICK_ORDER.filter(team => team === "red").length, 3);
  assert.deepEqual(pickOrderFor("red"), PICK_ORDER);
});

function fakeDiscordMessage(channel) {
  return {
    channel,
    edit: async () => {},
    createMessageComponentCollector() {
      const collector = new EventEmitter();
      collector.stop = reason => collector.emit("end", [], reason);
      return collector;
    },
  };
}

test("captain finalization starts RPS after the map is chosen", async () => {
  const sent = [];
  const cancelToken = { cancelled: false, cancel: null };
  const channel = {
    async send(payload) {
      sent.push(payload);
      const title = payload?.embeds?.[0]?.data?.title;
      if (title === "Captain RPS — Round 1") {
        setImmediate(() => {
          cancelToken.cancelled = true;
          cancelToken.cancel?.();
        });
      }
      return fakeDiscordMessage(channel);
    },
  };
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: String(1000 + index),
    name: `Player ${index + 1}`,
    captain: index < 2,
  }));
  const state = {
    queue: players.map(player => ({ ...player })),
    queueSnapshot: players.map(player => ({ ...player })),
    MAX_PLAYERS: 8,
    cancelledFlowPlayerIds: new Set(),
    isVotingInProgress: true,
    pendingTeam1Starts: "offense",
  };
  const elo = {
    getDisplayName: (_id, fallback) => fallback,
    getRating: () => 1941,
  };

  const result = await finalizeMatch(
    channel,
    {},
    {},
    state,
    { name: "East", ip: "127.0.0.1:27015" },
    { name: "shutdown2", mirv: 0 },
    elo,
    {},
    {},
    {},
    "STANDARD",
    {},
    null,
    { cancelToken }
  );

  assert.equal(result, null);
  assert.ok(sent.some(payload =>
    payload?.embeds?.[0]?.data?.title === "Captain RPS — Round 1"
  ));
  assert.ok(sent.includes(
    "⚠️ Captain draft canceled. The remaining players were returned to the queue."
  ));
});

test("captain substitutions preserve the drafted teams as Scenario 1", () => {
  const ratings = new Map([
    ["1", 3000], ["2", 2900], ["3", 2800], ["9", 2700],
    ["5", 1200], ["6", 1100], ["7", 1000], ["8", 900],
  ]);
  const elo = {
    db: {
      prepare: () => ({
        get: id => ({
          display_name: `Player ${id}`,
          name: `Player ${id}`,
          rating: ratings.get(String(id)),
        }),
      }),
    },
  };
  const player = id => ({ id, name: `Player ${id}` });
  const blue = ["1", "2", "3", "9"].map(player);
  const red = ["5", "6", "7", "8"].map(player);

  const scenarios = buildSubstitutionScenarios(blue, red, "CAPTAINS", elo);

  assert.deepEqual(scenarios[0].blue.map(p => p.id), ["1", "2", "3", "9"]);
  assert.deepEqual(scenarios[0].red.map(p => p.id), ["5", "6", "7", "8"]);
});

test("substituting a captain transfers the saved captain slot", () => {
  assert.deepEqual(
    replaceCaptainId({ blue: "1", red: "5" }, "1", "9"),
    { blue: "9", red: "5" }
  );
  assert.deepEqual(
    replaceCaptainId({ blue: "1", red: "5" }, "3", "9"),
    { blue: "1", red: "5" }
  );
});
