"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createPredictions } = require("../predictions");

function setup(t) {
  let now = 1000;
  const db = new Database(":memory:");
  db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT,blue_ids TEXT,red_ids TEXT,map_name TEXT,server_name TEXT)");
  const snapshot = {
    matchId: "READY1", blueIds: ["0", "1", "2", "3"], redIds: ["4", "5", "6", "7"], offenseIds: ["offense"],
    steamIdsByDiscordId: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), [`STEAM_0:1:${i}`]])),
    serverKey: "east", mapName: "shutdown2", team1Starts: "offense",
  };
  let roster = { complete: true, mapName: "shutdown2", steamIds: Object.values(snapshot.steamIdsByDiscordId).flat() };
  const s = createPredictions({ db, config: { predictionsEnabled: true }, clock: () => now,
    queryServerRoster: async key => { assert.equal(key, "east"); return roster; },
    waitForRosterRetry: async () => {}, logger: { warn() {} } });
  const m = s.onMatchFinalized(snapshot);
  t.after(() => { s.stop(); db.close(); });
  const report = outcome => db.prepare("INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?)").run(
    snapshot.matchId, outcome.toUpperCase(), "completed", JSON.stringify(snapshot.blueIds), JSON.stringify(snapshot.redIds), snapshot.mapName, "east");
  return { s, db, m, snapshot, report, time: n => { now = n; }, roster: next => { roster = next; } };
}

test("readiness keeps polling until the voted map and all eight official players are present together", async t => {
  const { s, m, snapshot, time, roster } = setup(t);
  const eight = Object.values(snapshot.steamIdsByDiscordId).flat();
  roster({ complete: true, mapName: "lobby", steamIds: eight });
  await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "open");
  assert.equal(s.store.market(m.id).closes_at, null);
  time(16000); roster({ complete: true, mapName: "shutdown2", steamIds: eight.slice(0, 7) });
  await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, null);
  time(31000); roster({ complete: true, mapName: "shutdown2", steamIds: [...eight.slice(0, 7), "STEAM_0:1:99"] });
  await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, null);
  time(46000); roster({ complete: true, mapName: "shutdown2", steamIds: eight });
  await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "countdown");
  assert.equal(s.store.market(m.id).closes_at, 166000);
  time(61000); await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, 166000);
});

test("three failed reads do not abandon readiness and later scans recover without trusting connect logs", async t => {
  const { s, m, snapshot, time } = setup(t);
  const query = s.queryServerRoster;
  s.queryServerRoster = async () => { throw new Error("RCON timeout"); };
  await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "open");
  assert.equal(s.store.market(m.id).closes_at, null);
  for (const steamid of Object.values(snapshot.steamIdsByDiscordId).flat()) await s.onHldsEvent({ type: "connect", serverKey: "east", steamid, userid: steamid });
  assert.equal(s.store.market(m.id).closes_at, null);
  s.queryServerRoster = query; time(16000); await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "countdown");
  assert.equal(s.store.market(m.id).closes_at, 136000);
});

test("selected-map reloads before readiness keep waiting instead of permanently freezing the game", async t => {
  const { s, m, snapshot, time, roster } = setup(t);
  roster({ complete: true, mapName: "shutdown2", steamIds: [] });
  await s.pollRosters();
  await s.onHldsEvent({ type: "map", name: "lobby", serverKey: "east" });
  time(16000); roster({ complete: true, mapName: "lobby", steamIds: [] }); await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "open");
  assert.equal(s.store.market(m.id).closes_at, null);
  time(31000); roster({ complete: true, mapName: "shutdown2", steamIds: Object.values(snapshot.steamIdsByDiscordId).flat() });
  await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, 151000);
});

test("map identity ignores case and surrounding whitespace but never accepts a different map variant", async t => {
  const { s, m, snapshot, time, roster } = setup(t);
  const steamIds = Object.values(snapshot.steamIdsByDiscordId).flat();
  roster({ complete: true, mapName: "shutdown2_lg", steamIds }); await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, null);
  time(16000); roster({ complete: true, mapName: " SHUTDOWN2 ", steamIds }); await s.pollRosters();
  assert.equal(s.store.market(m.id).closes_at, 136000);
});

test("monitoring failures after readiness preserve the original deadline and do not permanently halt settlement", async t => {
  const { s, m, time, report } = setup(t);
  await s.pollRosters();
  s.queryServerRoster = async () => { throw new Error("RCON timeout"); };
  time(16000); await s.pollRosters();
  assert.equal(s.store.market(m.id).state, "countdown");
  assert.equal(s.store.market(m.id).closes_at, 121000);
  time(121000); s.tick(); report("red"); s.onMatchReported({ matchId: "READY1" });
  assert.equal(s.store.market(m.id).state, "settled");
  assert.equal(s.store.market(m.id).result, "red");
});

test("a delayed map event from an older log cannot freeze a verified countdown", async t => {
  const { s, m } = setup(t);
  await s.onHldsEvent({ type: "map", name: "shutdown2", serverKey: "east", logInstance: "current.log" });
  await s.pollRosters();
  await s.onHldsEvent({ type: "map", name: "lobby", serverKey: "east", logInstance: "old.log" });
  assert.equal(s.store.market(m.id).state, "countdown");
  assert.equal(s.store.market(m.id).closes_at, 121000);
});

for (const outcome of ["red", "blue", "tie"]) {
  test(`a completed official ${outcome} result resolves a post-deadline map warning and pays exactly once`, async t => {
    const { s, db, m, time, report } = setup(t);
    for (const [user, pick] of [["correct", outcome], ["wrong", outcome === "blue" ? "red" : "blue"]]) {
      s.store.placeBet({ marketRef: { marketId: m.id, revision: 1 }, discordId: user, pick, stake: 100, context: s.context("bet", user) });
    }
    await s.pollRosters(); time(121000); s.tick();
    await s.onHldsEvent({ type: "map", name: "lobby", serverKey: "east" });
    report(outcome); s.onMatchReported({ matchId: "READY1" });
    assert.equal(s.store.market(m.id).state, "settled");
    assert.equal(s.store.market(m.id).result, outcome);
    assert.equal(s.store.account("correct").balance, outcome === "tie" ? 1090 : 1070);
    assert.equal(s.store.account("wrong").balance, 900);
    s.onMatchReported({ matchId: "READY1" }); await s.initialize();
    assert.equal(s.store.market(m.id).settlement_version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions WHERE kind='allocation'").get().n, 1);
    assert.equal(s.store.account("correct").balance, outcome === "tie" ? 1090 : 1070);
    assert.equal(s.store.assertAccounting(), true);
  });
}

for (const reason of ["unexpected server map", "server monitoring unavailable"]) {
test(`startup retries a completed report blocked by ${reason} with a verified expired deadline`, async t => {
  const { s, m, time, report } = setup(t);
  await s.pollRosters(); s.store.markReview(m.id, reason);
  time(121000); report("red"); await s.initialize();
  assert.equal(s.store.market(m.id).state, "settled");
  assert.equal(s.store.market(m.id).result, "red");
});
}

for (const issue of ["early-result", "changed-result"]) {
  test(`a later map event cannot clear owner review for ${issue}`, async t => {
    const { s, m, time, report } = setup(t);
    await s.pollRosters();
    if (issue === "early-result") {
      time(30000); report("blue"); s.onMatchReported({ matchId: "READY1" });
    } else {
      time(121000); report("blue"); s.observeOfficialResult({ matchId: "READY1", outcome: "blue" });
      report("red"); s.onMatchReported({ matchId: "READY1" });
    }
    const reason = s.store.market(m.id).reason;
    assert.equal(s.store.market(m.id).state, "review_required");
    time(130000); await s.onHldsEvent({ type: "map", name: "lobby", serverKey: "east" });
    assert.equal(s.store.market(m.id).reason, reason);
    s.onMatchReported({ matchId: "READY1" }); await s.initialize();
    assert.equal(s.store.market(m.id).state, "review_required");
    assert.equal(s.store.market(m.id).settlement_version, 0);
  });
}

for (const change of ["map", "teams", "server", "missing-deadline", "future-deadline", "other-review", "paid-review"]) {
  test(`automatic result recovery retains owner review for ${change}`, async t => {
    const { s, db, m, time, report } = setup(t);
    await s.pollRosters(); time(121000); report("red");
    if (change === "paid-review") { s.tick(); s.onMatchReported({ matchId: "READY1" }); }
    s.store.markReview(m.id, change === "other-review" ? "historical roster/terms change" : "unexpected server map");
    if (change === "map") db.prepare("UPDATE matches SET map_name='other'").run();
    if (change === "teams") db.prepare("UPDATE matches SET red_ids='[]'").run();
    if (change === "server") db.prepare("UPDATE matches SET server_name='west'").run();
    if (change === "missing-deadline") db.prepare("UPDATE prediction_markets SET closes_at=NULL WHERE id=?").run(m.id);
    if (change === "future-deadline") db.prepare("UPDATE prediction_markets SET closes_at=200000 WHERE id=?").run(m.id);
    s.onMatchReported({ matchId: "READY1" });
    assert.equal(s.store.market(m.id).state, "review_required");
    assert.equal(s.store.market(m.id).settlement_version, change === "paid-review" ? 1 : 0);
    assert.equal(s.store.market(m.id).observed_result, "red");
  });
}

test("failed automatic recovery rolls back the state, audit and payout and can be retried", async t => {
  const { s, db, m, time, report } = setup(t);
  s.store.placeBet({ marketRef: { marketId: m.id, revision: 1 }, discordId: "u", pick: "red", stake: 100, context: s.context("bet", "u") });
  await s.pollRosters(); time(121000); s.store.markReview(m.id, "unexpected server map"); report("red");
  db.exec("CREATE TRIGGER fail_payout BEFORE INSERT ON prediction_transactions WHEN NEW.kind='settlement' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => s.onMatchReported({ matchId: "READY1" }), /injected/);
  assert.equal(s.store.market(m.id).state, "review_required");
  assert.equal(s.store.account("u").balance, 900);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions WHERE kind='automatic_recovery'").get().n, 0);
  db.exec("DROP TRIGGER fail_payout"); s.onMatchReported({ matchId: "READY1" });
  assert.equal(s.store.market(m.id).state, "settled");
  assert.equal(s.store.account("u").balance, 1000);
  assert.equal(s.store.assertAccounting(), true);
});
