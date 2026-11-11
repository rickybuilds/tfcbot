"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatBonusAnnouncement } = require("../lib/modeElo");

test("streak bonus announcement identifies every triggering player and streak", () => {
  const message = formatBonusAnnouncement({ type: "WINNER_ONLY", triggeredBy: ["Alice (5 wins)", "Bob (7 wins)"] });
  assert.match(message, /Alice \(5 wins\)/);
  assert.match(message, /Bob \(7 wins\)/);
  assert.match(message, /triggered by streak/);
});

test("ADL bonus announcement identifies ADL without labeling it as a player", () => {
  const message = formatBonusAnnouncement({ type: "WINNER_ONLY", triggeredBy: ["ADL Mode"] });
  assert.match(message, /triggered by ADL Mode/);
  assert.doesNotMatch(message, /Players on a streak/);
});
