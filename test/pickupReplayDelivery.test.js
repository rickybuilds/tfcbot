"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");

// Exercise the real delivery state machine and SQL; replace only SSH and scheduling.
function delivery(t, responses, phase = "import") {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const logs = [], errors = [], commands = [];
  const mod = { exports: {} };
  const now = 1800000000000;
  vm.runInNewContext(fs.readFileSync(require.resolve("../services/pickupReplayDelivery"), "utf8"), {
    module: mod,
    require(name) {
      if (name !== "node:child_process") return require(name);
      return { execFile(file, args, options, callback) {
        commands.push(args.at(-1));
        const response = responses.shift();
        assert.ok(response, "unexpected SSH request");
        callback(response.error, response.stdout || "", response.stderr || "");
      } };
    },
    process: { env: { PICKUP_DELIVERY_SSH_KEY: __filename, PICKUP_DELIVERY_WEB_HOST: "127.0.0.1" } },
    Date: class extends Date { static now() { return now; } },
    setInterval: () => ({ unref() {} }), setImmediate() {},
  });
  const runner = new mod.exports.PickupReplayDelivery({ db, enabled: true,
    servers: { east: { ssh: { host: "east" } } }, isBusy: () => false,
    logger: { log: message => logs.push(message), error: message => errors.push(message) } });
  db.exec("CREATE TABLE matches(match_id TEXT,status TEXT); CREATE TABLE pickup_replay_recordings(server_key TEXT,match_id TEXT,started_at INTEGER,round_number INTEGER,observed_state TEXT,stopped_at INTEGER)");
  db.prepare("INSERT INTO pickup_replay_delivery_jobs(server_key,match_id,phase,updated_at) VALUES('east','J9B3BM',?,0)").run(phase);
  return { runner, logs, errors, commands, now,
    job: () => db.prepare("SELECT * FROM pickup_replay_delivery_jobs").get(),
    due: () => db.exec("UPDATE pickup_replay_delivery_jobs SET next_attempt=0") };
}

test("failed remote import retains exit code and both output streams in durable diagnostics", async t => {
  const d = delivery(t, [{ error: Object.assign(new Error("Command failed"), { code: 1 }),
    stdout: "imports: failed=1", stderr: "archive missing" }]);
  await d.runner.tick();
  assert.match(d.job().last_error, /exit=1/);
  assert.match(d.job().last_error, /imports: failed=1/);
  assert.match(d.job().last_error, /archive missing/);
  assert.equal(d.job().phase, "import");
  assert.equal(d.errors.length, 1);
});

for (const [code, reason] of [[73, /maintenance busy/i], [75, /details pending/i]]) {
  test(`import exit ${code} waits without inflating failure backoff, then completes without reupload`, async t => {
    const d = delivery(t, [{ error: Object.assign(new Error("Command failed"), { code }) }, {}]);
    await d.runner.tick();
    assert.equal(d.errors.length, 0);
    assert.ok(d.logs.some(line => reason.test(line)));
    assert.equal(d.job().attempts, 0);
    assert.equal(d.job().next_attempt, d.now + 30000);
    assert.equal(d.job().phase, "import");
    d.due();
    await d.runner.tick();
    assert.equal(d.job().phase, "done");
    assert.equal(d.job().last_error, null);
    assert.deepEqual(d.commands, ["maintain J9B3BM", "maintain J9B3BM"]);
  });
}

test("transport failures keep exponential backoff and distinguish SSH transport", async t => {
  const error = () => Object.assign(new Error("Command failed"), { code: 255 });
  const d = delivery(t, [{ error: error(), stderr: "Connection refused" }, { error: error() }]);
  await d.runner.tick();
  assert.match(d.job().last_error, /SSH transport failed/);
  assert.match(d.job().last_error, /exit=255/);
  d.due();
  await d.runner.tick();
  assert.equal(d.job().next_attempt, d.now + 60000);
  assert.equal(d.job().attempts, 2);
});

test("timeout diagnostics retain signal and killed status", async t => {
  const d = delivery(t, [{ error: Object.assign(new Error("Command timed out"), { code: null, signal: "SIGTERM", killed: true }) }]);
  await d.runner.tick();
  assert.match(d.job().last_error, /signal=SIGTERM/);
  assert.match(d.job().last_error, /killed=true/);
});

test("upload exit 75 remains a failure and never advances to import", async t => {
  const d = delivery(t, [{ error: Object.assign(new Error("Command failed"), { code: 75 }) }], "upload");
  await d.runner.tick();
  assert.equal(d.errors.length, 1);
  assert.equal(d.job().phase, "upload");
  assert.equal(d.job().attempts, 1);
});
