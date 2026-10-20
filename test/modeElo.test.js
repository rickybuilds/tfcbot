"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const bonusModule = require.resolve("../lib/modeElo");
const previousPercent = process.env.ELO_BONUS_PERCENT;
delete process.env.ELO_BONUS_PERCENT;
const { applyModeMultipliers } = require("../lib/modeElo");
if (previousPercent !== undefined) process.env.ELO_BONUS_PERCENT = previousPercent;

test("streak bonuses award 50% extra instead of the old random multiplier", () => {
  for (const rng_multiplier of [1.25, 2, 3, 4, 5]) {
    assert.equal(applyModeMultipliers({ mode: "STANDARD", rng_multiplier }, 20), 30);
  }
});

test("ADL awards 50% extra even when the legacy environment requests 3x", () => {
  const previous = process.env.ADL_ELO_MULTIPLIER;
  process.env.ADL_ELO_MULTIPLIER = "3";
  try {
    assert.equal(applyModeMultipliers({ mode: "ADL", rng_multiplier: 1.25 }, 20), 30);
    assert.equal(applyModeMultipliers({ mode: "ADL" }, 20), 30);
  } finally {
    if (previous === undefined) delete process.env.ADL_ELO_MULTIPLIER;
    else process.env.ADL_ELO_MULTIPLIER = previous;
  }
});

test("ADL and streak bonuses do not stack", () => {
  assert.equal(applyModeMultipliers({ mode: "ADL", rng_multiplier: 5 }, 20), 30);
});

test("regular gains and all losses remain unchanged", () => {
  assert.equal(applyModeMultipliers({ mode: "STANDARD", rng_multiplier: 1 }, 20), 20);
  assert.equal(applyModeMultipliers(null, 20), 20);
  assert.equal(applyModeMultipliers({ mode: "ADL", rng_multiplier: 5 }, -20), -20);
  assert.equal(applyModeMultipliers({ mode: "ADL" }, 0), 0);
});

test("bonus gains are rounded to whole Elo after the 50% boost", () => {
  assert.equal(applyModeMultipliers({ rng_multiplier: 1.25 }, 17), 26);
  assert.equal(applyModeMultipliers({ rng_multiplier: 1.25 }, 35), 53);
});

function configuredBonus(value, mode = "ADL") {
  const env = { ...process.env };
  if (value === undefined) delete env.ELO_BONUS_PERCENT;
  else env.ELO_BONUS_PERCENT = value;
  return Number(execFileSync(process.execPath, ["-e",
    `const m=require(${JSON.stringify(bonusModule)}); console.log(m.applyModeMultipliers({mode:${JSON.stringify(mode)},rng_multiplier:1.5},20));`
  ], { env, encoding: "utf8" }).trim());
}

test("the environment can reduce both bonus types back to 25 percent", () => {
  assert.equal(configuredBonus("25"), 25);
  assert.equal(configuredBonus("25", "STANDARD"), 25);
});

test("zero percent disables extra rewards", () => {
  assert.equal(configuredBonus("0"), 20);
  assert.equal(configuredBonus("0", "STANDARD"), 20);
});

test("missing or invalid bonus settings safely default to 50 percent", () => {
  for (const value of [undefined, "", " ", "nope", "-25", "101", "Infinity"]) {
    assert.equal(configuredBonus(value), 30);
  }
});
