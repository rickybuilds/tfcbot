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

test("six-player draft gives each team three picks with the middle snake pick", () => {
  assert.deepEqual(PICK_ORDER, ["blue", "red", "red", "blue", "blue", "red"]);
  assert.equal(PICK_ORDER.filter(team => team === "blue").length, 3);
  assert.equal(PICK_ORDER.filter(team => team === "red").length, 3);
  assert.deepEqual(pickOrderFor("red"), ["red", "blue", "blue", "red", "red", "blue"]);
});
