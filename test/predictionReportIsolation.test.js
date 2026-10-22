"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPredictions } = require("../predictions");

// Module imports create default stores. Keep every database used by this file
// in memory or in its own temporary directory, away from operator snapshots.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-report-isolation-"));
const cwd = process.cwd();
const banModule = require("../lib/banStore");
const OriginalBanStore = banModule.BanStore;
let banDb, admin, finalizeMatch, sharedState, defaultElo;
banModule.BanStore = class extends OriginalBanStore {
  constructor() { super(":memory:"); banDb = this.db; }
};
try {
  process.chdir(directory);
  admin = require("../commands/admin");
  ({ finalizeMatch } = require("../commands/voteFlow"));
  sharedState = require("../lib/state").state;
  defaultElo = require("../lib/elo");
} finally {
  process.chdir(cwd);
  banModule.BanStore = OriginalBanStore;
}
test.after(() => {
  banDb.close();
  defaultElo.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const ids = Array.from({ length: 8 }, (_, i) => String(100000000000000 + i));
function setup(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE matches(
    match_id TEXT PRIMARY KEY,created_at INTEGER,blue_ids TEXT,red_ids TEXT,
    offense_ids TEXT,team_scenarios TEXT,map_name TEXT,server_name TEXT,
    mode TEXT,rng_multiplier REAL,bonus_elo TEXT,winner TEXT,status TEXT,
    processed_at INTEGER,hampalyzer_url TEXT,tfcstats_url TEXT,
    avg_blue INTEGER,avg_red INTEGER
  ); CREATE TABLE ratings(player_id TEXT PRIMARY KEY,display_name TEXT,rating INTEGER)`);
  for (const id of ids) db.prepare("INSERT INTO ratings VALUES (?,?,1941)").run(id, id);
  const predictions = createPredictions({ db, config: { predictionsEnabled: true }, clock: () => 130000 });
  t.after(() => predictions.stop());
  return { db, predictions };
}
function seedReport(db, predictions) {
  db.prepare(`INSERT INTO matches(match_id,blue_ids,red_ids,map_name,server_name,mode,rng_multiplier,status)
    VALUES ('REPORT1',?,?,'shutdown2','east','STANDARD',1,'in_progress')`)
    .run(JSON.stringify(ids.slice(0, 4)), JSON.stringify(ids.slice(4)));
  const market = predictions.onMatchFinalized(predictions.snapshotFromRow(db.prepare("SELECT * FROM matches").get()));
  for (const [discordId, pick] of [["blue-bettor", "blue"], ["red-bettor", "red"]]) {
    predictions.store.placeBet({ marketRef: { marketId: market.id, revision: 1 }, discordId, pick, stake: 100, context: predictions.context("bet", discordId) });
  }
  predictions.store.startCountdown(market.id, 0);
  return market;
}

for (const mode of ["v1", "live-gentle"]) {
  for (const failure of ["observation", "settlement"]) {
    test(`${mode} report remains authoritative and schedules Elo after prediction ${failure} failure`, async t => {
      const { db, predictions } = setup(t);
      const market = seedReport(db, predictions);
      const secret = "private financial failure data";
      if (failure === "observation") {
        const observe = predictions.observeOfficialResult.bind(predictions);
        t.mock.method(predictions, "observeOfficialResult", args => { observe(args); throw new Error(secret); });
      } else {
        const settle = predictions.store.settleMarket.bind(predictions.store);
        t.mock.method(predictions.store, "settleMarket", args => { settle(args); throw new Error(secret); });
      }
      const warnings = [];
      t.mock.method(console, "warn", (...args) => warnings.push(args));
      const scheduled = [], sent = [], disarmed = [], eloCalls = [];
      const schedule = matchId => {
        assert.equal(db.inTransaction, false);
        assert.deepEqual(db.prepare("SELECT status,winner FROM matches WHERE match_id=?").get(matchId), { status: "completed", winner: "RED" });
        scheduled.push(matchId);
        return { scheduled: true };
      };
      const reg = new Map();
      const state = {
        matches: [{ id: "REPORT1", blueTeam: ids.slice(0, 4).map(id => ({ id })), redTeam: ids.slice(4).map(id => ({ id })) }],
        autoRecap: { disarmByMatchId: id => disarmed.push(id) },
      };
      admin.register(reg, {
        state, predictions, matchesStore: {},
        config: { channels: { pickup: "pickup", eloAdmin: "admin" }, eloV2Mode: mode },
        elo: {
          db, unreportMatch() {},
          applyTeamResult(_args, options) {
            assert.equal(db.prepare("SELECT status FROM matches").get().status, "in_progress");
            eloCalls.push(options?.dryRun || false);
            return { blue: [], red: [], bluePool: -1, redPool: 1 };
          },
        },
        eloShadow: { schedule, scheduleLive: schedule },
      });
      await reg.get("report")({
        internalAutoReport: true, author: { id: "bot" },
        channel: { id: "pickup", send: async payload => { sent.push(payload); return { id: "reported" }; } },
      }, ["REPORT1", "red", "--auto", "--score-blue=1", "--score-red=2"]);

      assert.deepEqual(db.prepare("SELECT status,winner FROM matches").get(), { status: "completed", winner: "RED" });
      assert.deepEqual(eloCalls, [mode === "live-gentle"]);
      assert.deepEqual(scheduled, ["REPORT1"]);
      assert.deepEqual(disarmed, ["REPORT1"]);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].embeds[0].data.title, "Match Reported");
      assert.match(sent[0].embeds[0].data.description, /Winner: \*\*RED\*\*/);
      assert.equal(predictions.store.market(market.id).settlement_version, 0);
      assert.equal(predictions.store.market(market.id).observed_result, null);
      assert.equal(predictions.store.account("blue-bettor").balance, 900);
      assert.equal(predictions.store.account("red-bettor").balance, 900);
      assert.equal(predictions.store.assertAccounting(), true);
      assert.ok(warnings.length > 0);
      assert.ok(warnings.every(args => !args.some(value => value instanceof Error)));
      assert.ok(!JSON.stringify(warnings).includes(secret));
    });
  }
}

function finalization(t) {
  const { db, predictions } = setup(t);
  const previousStreaks = global.__winStreakStore;
  global.__winStreakStore = { get: () => 0 };
  t.after(() => { global.__winStreakStore = previousStreaks; });
  const previousRecap = sharedState.autoRecap;
  const armed = [];
  sharedState.autoRecap = { armFromMatchReady: details => armed.push(details) };
  t.after(() => { sharedState.autoRecap = previousRecap; });
  const players = ids.map(id => ({ id, name: id }));
  const state = {
    predictions, matches: [], queue: [...players], queueSnapshot: [...players],
    offenseQueue: [], lockedServers: new Set(), lockedPlayers: new Map(), isVotingInProgress: true,
  };
  const sent = [], persisted = [];
  const channel = { id: "pickup", send: async payload => { sent.push(payload); return { id: `msg${sent.length}`, channelId: "pickup" }; } };
  const finalize = () => finalizeMatch(
    channel, { persistQueueSoon: () => persisted.push(true) }, { getNumber: (_key, fallback) => fallback }, state,
    { name: "TFC East US Server", ip: "east" }, { name: "shutdown2", mirv: 0 },
    { db, getDisplayName: (_id, name) => name, getRating: () => 1941 }, {}, {}, { channels: {} }, "STANDARD", {}, "NEW123"
  );
  return { db, predictions, state, sent, armed, persisted, finalize };
}
function assertArmed(fixture) {
  const { db, state, sent, armed, persisted } = fixture;
  assert.equal(db.prepare("SELECT status FROM matches WHERE match_id='NEW123'").get().status, "in_progress");
  assert.equal(state.lockedServers.has("east"), true);
  for (const id of ids) assert.equal(state.lockedPlayers.get(id), "NEW123");
  assert.deepEqual({ matchId: state.restartRequest.matchId, serverKey: state.restartRequest.serverKey, map: state.restartRequest.map }, { matchId: "NEW123", serverKey: "east", map: "shutdown2" });
  assert.equal(armed.length, 1);
  assert.equal(armed[0].matchId, "NEW123");
  assert.ok(state.matches.some(match => match.id === "NEW123" && match.blueTeam.length === 4));
  assert.deepEqual(state.queue, []);
  assert.equal(state.queueSnapshot, null);
  assert.equal(state.isVotingInProgress, false);
  assert.equal(persisted.length, 1);
  return sent.filter(payload => (payload?.embeds?.[0]?.data?.title || payload?.embeds?.[0]?.title)?.startsWith("Match Ready"));
}

test("prediction finalization rolls back only its writes and still arms the saved pickup", async t => {
  const fixture = finalization(t), { predictions, db } = fixture;
  const finalize = predictions.onMatchFinalized.bind(predictions);
  t.mock.method(predictions, "onMatchFinalized", snapshot => { finalize(snapshot); throw new Error("private financial failure data"); });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  await fixture.finalize();
  const cards = assertArmed(fixture);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].components, undefined);
  assert.equal(predictions.store.latest("NEW123"), null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions").get().n, 0);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every(args => !args.some(value => value instanceof Error)));
  assert.ok(!JSON.stringify(warnings).includes("private financial failure data"));
});

test("prediction message binding failure after a successful send still arms without a duplicate Match Ready", async t => {
  const fixture = finalization(t), { predictions } = fixture;
  t.mock.method(predictions, "bindMessage", () => { throw new Error("private financial failure data"); });
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  await fixture.finalize();
  const cards = assertArmed(fixture);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].components.length, 1);
  assert.equal(predictions.store.latest("NEW123").message_id, null);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every(args => !args.some(value => value instanceof Error)));
  assert.ok(!JSON.stringify(warnings).includes("private financial failure data"));
});

test("base pickup persistence failure still stops before publication and arming", async t => {
  const fixture = finalization(t), { db, state, predictions, sent, armed } = fixture;
  db.exec("CREATE TRIGGER fail_base BEFORE INSERT ON matches BEGIN SELECT RAISE(ABORT,'base persistence failed'); END");
  t.mock.method(console, "error", () => {});
  await assert.rejects(fixture.finalize(), /base persistence failed/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM matches").get().n, 0);
  assert.equal(predictions.store.latest("NEW123"), null);
  assert.equal(sent.length, 0);
  assert.equal(state.lockedPlayers.size, 0);
  assert.equal(state.lockedServers.size, 0);
  assert.equal(state.restartRequest, undefined);
  assert.equal(armed.length, 0);
});

test("repeated reports preserve the first completed report time for betting-window validation",async t=>{
 const {db,predictions}=setup(t);seedReport(db,predictions);const reg=new Map();admin.register(reg,{state:{matches:[{id:"REPORT1",blueTeam:ids.slice(0,4).map(id=>({id})),redTeam:ids.slice(4).map(id=>({id}))}]},predictions,matchesStore:{},config:{channels:{pickup:"pickup",eloAdmin:"admin"}},elo:{db,unreportMatch(){},applyTeamResult(){}}});
 const message={internalAutoReport:true,author:{id:"bot"},channel:{id:"pickup",send:async()=>({id:"report"})}};
 t.mock.method(Date,"now",()=>50000);await reg.get("report")(message,["REPORT1","blue","--auto"]);assert.equal(db.prepare("SELECT processed_at FROM matches").get().processed_at,50);
 t.mock.method(Date,"now",()=>130000);await reg.get("report")(message,["REPORT1","blue","--auto"]);assert.equal(db.prepare("SELECT processed_at FROM matches").get().processed_at,50);
});