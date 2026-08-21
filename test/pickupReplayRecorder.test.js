"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  PickupReplayRecorder,
  validateIdentity,
} = require("../services/pickupReplayRecorder");
const { attachAutoRecap, armed } = require("../services/autoRecap");
const rconServers = require("../config/rcon");
const { sendRecapWithDemos } = require("../services/discordUpload");
const { isWebmFile } = require("../services/pickupReplayRenderer");

const quietLogger = { info() {}, warn() {}, error() {}, log() {} };

async function renderPickupRecap(replayRounds) {
  let sentPayload;
  const client = {
    channels: {
      fetch: async () => ({
        send: async payload => {
          sentPayload = payload;
        },
      }),
    },
  };

  await sendRecapWithDemos(client, "channel-id", {
    matchInfo: {
      map: "phantom_lg",
      scoreBlue: 100,
      scoreRed: 110,
      winner: "red",
      matchId: "ZY9NGT",
      server: "east",
    },
    replayRounds,
  });

  return sentPayload.embeds[0].toJSON();
}

function harness(responder, options = {}) {
  const db = new Database(":memory:");
  const commands = [];
  const recorder = new PickupReplayRecorder({
    db,
    enabled: options.enabled ?? true,
    retries: options.retries ?? 3,
    logger: quietLogger,
    runRconCommand: async (serverKey, command) => {
      commands.push({ serverKey, command });
      return responder(command, commands.length);
    },
  });
  return { db, commands, recorder };
}

test("round one starts and explicitly stops", async () => {
  const h = harness(command => command.includes("start")
    ? "STARTED match_id=match_1 round=1 dir=match_1/round-01"
    : "READY match_id=match_1 round=1");
  await h.recorder.start("east", "match_1", 1);
  await h.recorder.stop("east", "match_1", 1);
  assert.deepEqual(h.commands.map(x => x.command), [
    'amx_pr_start "match_1" 1',
    'amx_pr_stop "match_1" 1',
  ]);
  const row = h.db.prepare("SELECT * FROM pickup_replay_recordings").get();
  assert.equal(row.desired_state, "stopped");
  assert.equal(row.observed_state, "ready");
  h.db.close();
});

test("round two reuses the match ID with round number two", async () => {
  const h = harness(command => {
    const round = command.endsWith(" 2") ? 2 : 1;
    return command.includes("start")
      ? `STARTED match_id=same-match round=${round} dir=same-match/round-0${round}`
      : `READY match_id=same-match round=${round}`;
  });
  await h.recorder.start("east", "same-match", 1);
  await h.recorder.stop("east", "same-match", 1);
  await h.recorder.start("east", "same-match", 2);
  await h.recorder.stop("east", "same-match", 2);
  assert.deepEqual(h.commands.map(x => x.command), [
    'amx_pr_start "same-match" 1', 'amx_pr_stop "same-match" 1',
    'amx_pr_start "same-match" 2', 'amx_pr_stop "same-match" 2',
  ]);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS count FROM pickup_replay_recordings").get().count, 2);
  h.db.close();
});

test("duplicate and concurrent starts serialize to one command", async () => {
  const h = harness(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return "STARTED match_id=dup round=1 dir=dup/round-01";
  });
  const results = await Promise.all([
    h.recorder.start("east", "dup", 1),
    h.recorder.start("east", "dup", 1),
  ]);
  assert.equal(h.commands.length, 1);
  assert.equal(results[1].idempotent, true);
  h.db.close();
});

test("map-load restart bypasses durable recording state for the same round", async () => {
  const h = harness(() => "STARTED match_id=dup round=1 dir=dup/round-01");
  await h.recorder.start("east", "dup", 1);
  await h.recorder.start("east", "dup", 1, { restart: true });
  assert.deepEqual(h.commands.map(x => x.command), [
    'amx_pr_start "dup" 1',
    'amx_pr_start "dup" 1',
  ]);
  h.db.close();
});

test("ALREADY_RECORDING for the requested identity is success", async () => {
  const h = harness(() => "ALREADY_RECORDING match_id=dup round=1");
  const result = await h.recorder.start("east", "dup", 1);
  assert.equal(result.idempotent, true);
  h.db.close();
});

test("duplicate stops and AMXX auto-stop NOT_RECORDING are idempotent without artifact confirmation", async () => {
  const h = harness(() => "NOT_RECORDING");
  const first = await h.recorder.stop("east", "auto-stop", 1);
  const second = await h.recorder.stop("east", "auto-stop", 1);
  assert.equal(first.artifactConfirmed, false);
  assert.equal(second.idempotent, true);
  assert.equal(h.commands.length, 1);
  h.db.close();
});

test("start rejects a different active identity", async () => {
  const h = harness(() => "REJECTED active_match_id=other active_round=2");
  await assert.rejects(h.recorder.start("east", "wanted", 1), /identity conflict/);
  assert.equal(h.db.prepare("SELECT observed_state FROM pickup_replay_recordings").get().observed_state, "conflict");
  h.db.close();
});

test("stop identity mismatch is surfaced", async () => {
  const h = harness(() => "STOP_REJECTED requested_match_id=wanted");
  await assert.rejects(h.recorder.stop("east", "wanted", 1), /identity mismatch/);
  h.db.close();
});

test("finalization failure is surfaced and persisted", async () => {
  const h = harness(() => "FINALIZE_FAILED match_id=wanted round=1");
  await assert.rejects(h.recorder.stop("east", "wanted", 1), /finalization failed/);
  assert.equal(h.db.prepare("SELECT observed_state FROM pickup_replay_recordings").get().observed_state, "finalize_failed");
  h.db.close();
});

test("RCON timeout is retried and attempt counts are durable", async () => {
  const h = harness((_command, attempt) => {
    if (attempt === 1) throw new Error("RCON UDP timeout");
    return "STARTED match_id=retry round=1 dir=retry/round-01";
  });
  await h.recorder.start("east", "retry", 1);
  assert.equal(h.commands.length, 2);
  assert.equal(h.db.prepare("SELECT start_attempts FROM pickup_replay_recordings").get().start_attempts, 2);
  h.db.close();
});

test("restart reconciliation adopts the correct active round without start or stop", async () => {
  const h = harness(() => "ACTIVE match_id=restart round=1 duration=12 rows=8");
  h.recorder._ensureRow("east", { matchId: "restart", roundNumber: 1 }, "recording");
  const result = await h.recorder.reconcile("east");
  assert.equal(result.state, "recording");
  assert.deepEqual(h.commands.map(x => x.command), ["amx_pr_status"]);
  h.db.close();
});

test("restart reconciliation preserves a different active round and records a conflict", async () => {
  const h = harness(() => "ACTIVE match_id=someone_else round=2 duration=12 rows=8");
  h.recorder._ensureRow("east", { matchId: "restart", roundNumber: 1 }, "recording");
  const result = await h.recorder.reconcile("east");
  assert.equal(result.conflict, true);
  assert.equal(h.db.prepare("SELECT observed_state FROM pickup_replay_recordings").get().observed_state, "conflict");
  assert.deepEqual(h.commands.map(x => x.command), ["amx_pr_status"]);
  h.db.close();
});

test("restart reconciliation fulfills a persisted stop only after status confirms identity", async () => {
  const h = harness(command => command === "amx_pr_status"
    ? "ACTIVE match_id=finish-me round=2 duration=12 rows=8"
    : "READY match_id=finish-me round=2");
  h.recorder._ensureRow("east", { matchId: "finish-me", roundNumber: 2 }, "stopped");
  const result = await h.recorder.reconcile("east");
  assert.equal(result.reconciledAction, "stop");
  assert.deepEqual(h.commands.map(x => x.command), ["amx_pr_status", 'amx_pr_stop "finish-me" 2']);
  h.db.close();
});

test("stop completes before a following map reset", async () => {
  const order = [];
  const h = harness(async command => {
    order.push(command);
    return "READY match_id=ordered round=1";
  });
  await h.recorder.stop("east", "ordered", 1);
  order.push("amx_map shutdown2");
  assert.deepEqual(order, ['amx_pr_stop "ordered" 1', "amx_map shutdown2"]);
  h.db.close();
});

test("autoRecap starts before spectator setup and stops before the round-two map reset", async () => {
  const order = [];
  const recorder = {
    async reconcileAll() { return []; },
    async start(_server, matchId, round, options) {
      order.push(`start:${matchId}:${round}:${options?.restart === true ? "restart" : "normal"}`);
    },
    async stop(_server, matchId, round) { order.push(`stop:${matchId}:${round}`); },
  };
  const channel = { async send() {} };
  const client = {
    channels: {
      cache: { get: () => channel },
      fetch: async () => channel,
    },
  };
  const db = new Database(":memory:");
  const autoRecap = attachAutoRecap(
    { client, matchesStore: { db } },
    {
      recorder,
      startVoiceBots: async () => order.push("spectator-setup"),
      stopVoiceBots: async () => order.push("spectator-stop"),
      runRconCommand: async (_server, command) => order.push(command),
    }
  );
  autoRecap.armFromMatchReady({ matchId: "ordered", map: "shutdown2", serverIp: undefined });
  await autoRecap.onEvent({ type: "map", name: "shutdown2", from: undefined });
  await autoRecap.onEvent({ type: "score_pair", blue: 1, red: 0, from: undefined });

  assert.ok(order.indexOf("start:ordered:1:restart") < order.indexOf("spectator-setup"));
  assert.ok(order.indexOf("stop:ordered:1") < order.indexOf("amx_map shutdown2"));
  await autoRecap.disarmByMatchId("ordered");
  db.close();
});

function autoRecapHarness({ stopFails = false } = {}) {
  const db = new Database(":memory:");
  const commands = [];
  const channel = { async send() {} };
  const recorder = {
    async reconcileAll() {},
    async start(serverKey, matchId, round) {
      commands.push({ type: "start", serverKey, matchId, round });
    },
    async stop(serverKey, matchId, round) {
      commands.push({ type: "stop", serverKey, matchId, round });
      if (stopFails) throw new Error("simulated replay stop failure");
    },
  };
  const client = {
    channels: {
      cache: { get: () => channel },
      fetch: async () => channel,
    },
  };
  const autoRecap = attachAutoRecap(
    { client, matchesStore: { db } },
    {
      recorder,
      startVoiceBots: async () => {},
      stopVoiceBots: async () => {},
      runRconCommand: async (serverKey, command) => commands.push({ type: "rcon", serverKey, command }),
    }
  );
  autoRecap.armFromMatchReady({ matchId: "XARD55", map: "blutopia_tfp", serverIp: "east" });
  return { autoRecap, commands, db };
}

test("SKILLS map events do not mutate pickup AutoRecap state", async () => {
  const skillKey = Object.keys(rconServers).find(key => rconServers[key].trackingOnly);
  assert.ok(skillKey, "a tracking-only SKILLS server must be configured");
  const h = autoRecapHarness();
  await h.autoRecap.onEvent({ type: "map", name: "blutopia_tfp", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  const before = armed.get("east");
  before.liveCaps = 3;
  before.liveScore = 30;
  await h.autoRecap.onEvent({ type: "map", name: "raiden9", serverKey: skillKey, from: "shared-host", sourcePort: 27016 });
  const after = armed.get("east");
  assert.equal(after.lastMapSeen, "blutopia_tfp");
  assert.equal(after.liveCaps, 3);
  assert.equal(after.liveScore, 30);
  assert.equal(after.mapInterrupted, false);
  await h.autoRecap.disarmByMatchId("XARD55");
  h.db.close();
});

test("pickup Half 1 is accepted after SKILLS activity and reload starts Round 2", async () => {
  const skillKey = Object.keys(rconServers).find(key => rconServers[key].trackingOnly);
  const h = autoRecapHarness();
  await h.autoRecap.onEvent({ type: "map", name: "blutopia_tfp", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  await h.autoRecap.onEvent({ type: "map", name: "raiden9", serverKey: skillKey, from: "shared-host", sourcePort: 27016 });
  await h.autoRecap.onEvent({ type: "score_pair", map: "blutopia_tfp", blue: 80, red: 0, serverKey: "east", from: "shared-host", sourcePort: 27015 });
  assert.equal(armed.get("east").half, 1);
  assert.deepEqual(armed.get("east").halfScores, [{ blue: 80, red: 0 }]);
  await h.autoRecap.onEvent({ type: "map", name: "blutopia_tfp", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  const starts = h.commands.filter(command => command.type === "start" && command.matchId === "XARD55");
  assert.equal(starts.at(-1).round, 2);
  await h.autoRecap.disarmByMatchId("XARD55");
  h.db.close();
});

test("replay stop failure cannot discard a committed Half 1", async () => {
  const h = autoRecapHarness({ stopFails: true });
  await h.autoRecap.onEvent({ type: "map", name: "blutopia_tfp", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  await h.autoRecap.onEvent({ type: "score_pair", map: "blutopia_tfp", blue: 80, red: 0, serverKey: "east", from: "shared-host", sourcePort: 27015 });
  assert.equal(armed.get("east").half, 1);
  assert.deepEqual(armed.get("east").halfScores, [{ blue: 80, red: 0 }]);
  await h.autoRecap.disarmByMatchId("XARD55");
  h.db.close();
});

test("unexpected pickup map preserves pending live state until recovery", async () => {
  const h = autoRecapHarness();
  await h.autoRecap.onEvent({ type: "map", name: "blutopia_tfp", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  const active = armed.get("east");
  active.liveCaps = 4;
  active.liveScore = 40;
  await h.autoRecap.onEvent({ type: "map", name: "raiden9", serverKey: "east", from: "shared-host", sourcePort: 27015 });
  assert.equal(active.lastMapSeen, "blutopia_tfp");
  assert.equal(active.liveCaps, 4);
  assert.equal(active.liveScore, 40);
  assert.equal(active.mapInterrupted, true);
  await h.autoRecap.disarmByMatchId("XARD55");
  h.db.close();
});

test("feature flag disabled sends no recorder commands", async () => {
  const h = harness(() => { throw new Error("should not run"); }, { enabled: false });
  assert.equal((await h.recorder.start("east", "disabled", 1)).disabled, true);
  assert.equal((await h.recorder.stop("east", "disabled", 1)).disabled, true);
  assert.equal(h.commands.length, 0);
  h.db.close();
});

test("unsafe match IDs and invalid round numbers are rejected before RCON", async () => {
  assert.throws(() => validateIdentity('bad";quit', 1), /Unsafe/);
  assert.throws(() => validateIdentity("safe", 0), /round/);
  const h = harness(() => "unexpected");
  await assert.rejects(h.recorder.start("east", 'bad";quit', 1), /Unsafe/);
  assert.equal(h.commands.length, 0);
  h.db.close();
});

test("pickup recap links only recorder-confirmed replay rounds", async () => {
  const embed = await renderPickupRecap([1]);
  const detailField = embed.fields.find(field => field.name === "\u200B");

  assert.match(detailField.value, /Watch Replay: \[Round 1\]/);
  assert.match(detailField.value, /matchId=ZY9NGT&round=1/);
  assert.doesNotMatch(detailField.value, /Round 2/);
});

test("pickup recap omits replay links when no recording was confirmed", async () => {
  const embed = await renderPickupRecap([]);
  const detailField = embed.fields.find(field => field.name === "\u200B");

  assert.doesNotMatch(detailField.value, /Watch Replay/);
  assert.doesNotMatch(detailField.value, /pickup-replay\.html/);
});

test("WebM renderer validation rejects mislabeled downloads", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "tfc-webm-test-"));
  try {
    const validPath = path.join(directory, "clip.webm");
    const invalidPath = path.join(directory, "clip-invalid.webm");
    await fsp.writeFile(validPath, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    await fsp.writeFile(invalidPath, Buffer.from("Cr24"));

    assert.equal(await isWebmFile(validPath), true);
    assert.equal(await isWebmFile(invalidPath), false);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
