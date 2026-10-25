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

test("live addoff settlement rates eight regulars and leaves extras unchanged", async () => {
  const { EloShadowService } = require("../services/eloShadow");
  elo.db.exec(`CREATE TABLE matches (
    match_id TEXT PRIMARY KEY, winner TEXT, status TEXT, blue_ids TEXT, red_ids TEXT,
    offense_ids TEXT, mode TEXT, rng_multiplier REAL
  ); CREATE TABLE player_steam_ids (discord_id TEXT, steam_id TEXT);`);
  const blue = roster("liveb", 900), red = roster("liver", 900);
  elo.setRatingAdmin("extra-high", 2200, "extra-high");
  elo.setRatingAdmin("extra-low", 600, "extra-low");
  const ids = [...blue, ...red].map(p => p.id);
  ids.forEach((id, index) => elo.db.prepare("INSERT INTO player_steam_ids VALUES (?, ?)").run(id, `STEAM_${index}`));
  elo.db.prepare("INSERT INTO matches VALUES (?, 'BLUE', 'completed', ?, ?, ?, 'STANDARD', 1)").run(
    "LIVEOFF", JSON.stringify(ids.slice(0, 4)), JSON.stringify(ids.slice(4)),
    JSON.stringify({ blue: ["extra-high"], red: ["extra-low"] })
  );
  const players = ids.map((_id, index) => ({ steam_id: `STEAM_${index}`, final_score: 160 - index * 20 }));
  const service = new EloShadowService({
    db: elo.db, elo, mode: "live-gentle", postingEnabled: false, requireLocalImport: false,
    maxAttempts: 1, logger: { info() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, match: {
      id: "LIVEOFF", status: "completed",
      nn_mvp: { available: true, formula_version: "nn-mvp-v1", players: players.map(p => ({ ...p, final_score: 0 })) },
      elo_performance: { available: true, scope: "official-roster", roster_ids: ids, formula_version: "nn-mvp-v1", players },
    } }) }),
  });
  const prepared = elo.applyTeamResult({ matchId: "LIVEOFF", blue, red, winner: "blue" }, { dryRun: true });
  prepared.blue = prepared.blue.map(p => ({ ...p, currentDelta: prepared.bluePool }));
  prepared.red = prepared.red.map(p => ({ ...p, currentDelta: prepared.redPool }));
  service.scheduleLive("LIVEOFF", prepared, { delayMs: 60000 });
  const snapshot = await service.runNow("LIVEOFF");
  assert.equal(snapshot.fallbackReason, null);
  const changes = elo.getChangesByMatch.all("LIVEOFF");
  assert.equal(changes.length, 8);
  assert.deepEqual(new Set(changes.map(p => p.player_id)), new Set(ids));
  assert.notDeepEqual(changes.filter(p => p.player_id.startsWith("liveb")).map(p => p.delta), [20, 20, 20, 20]);
  assert.equal(changes.filter(p => p.player_id.startsWith("liveb")).reduce((n, p) => n + p.delta, 0), 80);
  assert.equal(changes.filter(p => p.player_id.startsWith("liver")).reduce((n, p) => n + p.delta, 0), -80);
  assert.equal(elo.peekRating("extra-high"), 2200);
  assert.equal(elo.peekRating("extra-low"), 600);
  await service.runNow("LIVEOFF");
  assert.equal(elo.getChangesByMatch.all("LIVEOFF").length, 8);
});
