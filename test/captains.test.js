"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PICK_ORDER, captainIds, isCaptainMode, pickOrderFor } = require("../lib/captains");

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
