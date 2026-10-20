"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// elo.js creates a default database when loaded. Keep it away from the
// downloaded production snapshot, as well as all per-test databases.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfcbot-bonus-"));
const cwd = process.cwd();
const oldK = process.env.ELO_K;
const oldPercent = process.env.ELO_BONUS_PERCENT;
process.env.ELO_BONUS_PERCENT = "50";
process.env.ELO_K = "40";
let elo;
try {
  process.chdir(directory);
  elo = require("../lib/elo");
} finally {
  process.chdir(cwd);
  if (oldPercent === undefined) delete process.env.ELO_BONUS_PERCENT;
  else process.env.ELO_BONUS_PERCENT = oldPercent;
  if (oldK === undefined) delete process.env.ELO_K;
  else process.env.ELO_K = oldK;
}
test.after(() => {
  elo.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function roster(prefix, rating) {
  return Array.from({ length: 4 }, (_, i) => {
    const id = `${prefix}${i}`;
    elo.setRatingAdmin(id, rating, id);
    return { id, name: id };
  });
}

test("live preparation awards a 120-point bonus pool and regular 80-point losses", () => {
  const blue = roster("win", 2000), red = roster("lose", 2000);
  const prepared = elo.applyTeamResult({ matchId: "BONUS", blue, red, winner: "blue", match: { rng_multiplier: 1.25 } }, { dryRun: true });
  assert.equal(prepared.bluePool * 4, 120);
  assert.equal(prepared.redPool * 4, -80);
  assert.equal(elo.peekRating(blue[0].id), 2000);
});

test("draws receive no winner bonus even when one side has a positive adjustment", () => {
  const blue = roster("drawb", 2100), red = roster("drawr", 2000);
  const args = { matchId: "DRAW", blue, red, winner: "tie" };
  const normal = elo.applyTeamResult(args, { dryRun: true });
  const bonus = elo.applyTeamResult({ ...args, match: { mode: "ADL", rng_multiplier: 1.25 } }, { dryRun: true });
  assert.equal(bonus.bluePool, normal.bluePool);
  assert.equal(bonus.redPool, normal.redPool);
});

test("the normal cap is applied before the percentage winner bonus", () => {
  const blue = roster("upsetb", 1000), red = roster("upsetr", 3000);
  const prepared = elo.applyTeamResult({ matchId: "UPSET", blue, red, winner: "blue", match: { rng_multiplier: 1.25 } }, { dryRun: true });
  assert.equal(prepared.bluePool, 53);
});

test("recordMatch and applyTeamResult both apply the same balanced ADL reward", () => {
  const blue = roster("recordb", 2000), red = roster("recordr", 2000);
  const result = elo.recordMatch(blue.map(p => p.id), red.map(p => p.id), "red", { matchId: "RECORD", match: { mode: "ADL", rng_multiplier: 1.25 } });
  assert.deepEqual(result.blue.map(p => p.delta), [-20, -20, -20, -20]);
  assert.deepEqual(result.red.map(p => p.delta), [30, 30, 30, 30]);
});
