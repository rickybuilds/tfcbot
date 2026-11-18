"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const { formatHltvAnalysisNotification } = require("../services/hltvReviewAlerts");

test("HLTV analysis embeds are accurate, bounded, and safe for scanner outcomes",()=>{
  const base={match_id:"EFWN6W",map:"2fort",demo_id:"demo-1",run_id:"run-1",wall_track_count:2,snap_count:1,candidates:[
    {kind:"track",player_name:"eDub",time_seconds:93.778,duration_seconds:.53},
    {kind:"snap",player_name:"eDub",time_seconds:246.256}
  ]};
  const message=formatHltvAnalysisNotification({outcome:"candidates_found",...base},"https://nonamepickup.servehalflife.com/admin/hltv-review?demo=demo-1&tab=Wall-Track");
  assert.equal(message.allowedMentions.parse.length,0);assert.match(message.embeds[0].data.title,/NN\/\/TFC/);assert.match(JSON.stringify(message.embeds[0].toJSON()),/EFWN6W/);assert.match(JSON.stringify(message.embeds[0].toJSON()),/01:33\.778/);assert.match(JSON.stringify(message.embeds[0].toJSON()),/not cheating verdicts/i);
  const many={...base,candidates:Array.from({length:200},(_,i)=>({kind:"track",player_name:"Player "+i,time_seconds:i,duration_seconds:.5}))};
  const bounded=formatHltvAnalysisNotification({outcome:"candidates_found",...many},"https://nonamepickup.servehalflife.com/admin/hltv-review?demo=demo-1");const json=bounded.embeds[0].toJSON();assert.ok(JSON.stringify(json).length<6000);assert.match(JSON.stringify(json),/additional candidate/i);
  const failed=formatHltvAnalysisNotification({outcome:"failed",match_id:"EFWN6W",map:"2fort",demo_id:"demo-1",run_id:"run-3",failure_code:"missing_map_asset",failure_message:"Private map assets are unavailable.",retryable:false,next_action:"Provision assets."},"https://nonamepickup.servehalflife.com/admin/hltv-review?demo=demo-1");assert.match(JSON.stringify(failed.embeds[0].toJSON()),/missing_map_asset/);assert.match(JSON.stringify(failed.embeds[0].toJSON()),/Provision assets/);
});

test("HLTV analysis alert delivery leases, retries, and survives concurrent drains",async t=>{
  const BetterSqlite=require("better-sqlite3"),os=require("node:os"),path=require("node:path"),fs=require("node:fs"),{PermissionFlagsBits}=require("discord.js");
  const dbPath=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"hltv-alert-")),"registry.db"),db=new BetterSqlite(dbPath);t.after(()=>{db.close();try{fs.rmSync(path.dirname(dbPath),{recursive:true,force:true});}catch{}});
  db.exec("CREATE TABLE hltv_alerts(id TEXT PRIMARY KEY,demo_id TEXT,kind TEXT NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER)");
  db.exec("CREATE TABLE hltv_upstream_runs(id TEXT PRIMARY KEY)");db.exec("CREATE TABLE hltv_analysis_notifications(alert_id TEXT PRIMARY KEY,run_id TEXT UNIQUE,data_json TEXT NOT NULL,outcome TEXT NOT NULL,created_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO hltv_alerts(id,demo_id,kind,created_at) VALUES(?,?,?,?)").run("alert-1","demo-1","hltv_analysis_candidates",Date.now());
  db.prepare("INSERT INTO hltv_analysis_notifications(alert_id,run_id,data_json,outcome,created_at) VALUES(?,?,?,?,?)").run("alert-1","run-1",JSON.stringify({outcome:"completed_empty",match_id:"EFWN6W",map:"2fort",demo_id:"demo-1",run_id:"run-1",wall_track_count:0,snap_count:0,candidates:[]}),"completed_empty",Date.now());
  let sendAttempts=0;const channel={guildId:"guild",isThread:()=>false,isTextBased:()=>true,permissionOverwrites:{cache:new Map([['guild',{id:'guild',deny:{has:p=>p===PermissionFlagsBits.ViewChannel},allow:{has:()=>false}}],['reviewer',{id:'reviewer',type:1,deny:{has:()=>false},allow:{has:()=>true}}]])},send:async()=>{sendAttempts++;if(sendAttempts===1)throw Error("transient Discord failure");}};
  const client={user:{id:"bot"},channels:{fetch:async()=>channel}};let callbacks=[];const originalInterval=global.setInterval;global.setInterval=fn=>{callbacks.push(fn);return {unref(){}};};t.after(()=>{global.setInterval=originalInterval;});
  const {startHltvReviewAlerts}=require("../services/hltvReviewAlerts"),env={HLTV_REGISTRY_ENABLED:"true",HLTV_ALERTS_ENABLED:"true",HLTV_REGISTRY_DB:dbPath,HLTV_REVIEW_ALERT_CHANNEL_ID:"123456789012345678",HLTV_REVIEW_ALLOWED_USER_IDS:"reviewer",HLTV_REVIEW_BASE_URL:"https://nonamepickup.servehalflife.com"};
  startHltvReviewAlerts(client,env);assert.equal(callbacks.length,1);await callbacks[0]();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(db.prepare("SELECT attempts FROM hltv_alerts WHERE id='alert-1'").get().attempts,1);
  db.prepare("UPDATE hltv_alerts SET next_attempt=0").run();await Promise.all([callbacks[0](),callbacks[0]()]);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(sendAttempts,2);assert.ok(db.prepare("SELECT sent_at FROM hltv_alerts WHERE id='alert-1'").get().sent_at);
});

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
