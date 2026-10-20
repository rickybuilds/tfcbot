"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseLine } = require("../services/hldsLogs");
const { parseStatus, rosterPresence, PresenceTracker } = require("../predictions/presence");
const { phaseFromLog } = require("../predictions/phase");

const steam = n => `STEAM_0:1:${n}`;
const status = ids => `hostname: test\nmap : shutdown2 at: 0 x, 0 y, 0 z\nplayers : ${ids.length} active (16 max)\n# name userid uniqueid frag time ping loss adr\n${ids.map((s,i) => `# ${i+1} "Player ${i}" ${i+10} ${s} 0 00:10 20 0`).join("\n")}\n${ids.length} users\n`;
test("recorded prematch end is recognized independently of warmup and map load", () => {
  for (const file of fs.readdirSync(path.join(__dirname, "../parser/upstream/test")).filter(f => f.endsWith(".log"))) {
    const lines = fs.readFileSync(path.join(__dirname, "../parser/upstream/test", file), "utf8").split(/\r?\n/);
    const start = lines.find(l => l.includes('World triggered "Match_Begins_Now"'));
    assert.equal(parseLine(start).type, "prediction_live_start");
    assert.ok(parseLine(start).sourceTime);
    assert.equal(parseLine(lines.find(l => l.includes("Started map"))).type, "map");
    assert.equal(parseLine(lines.find(l => l.includes(" killed "))).type, "kill");
  }
});
test("raw status validates completeness and authenticates IDs without name matching", () => {
  const parsed = parseStatus(status([steam(1), steam(2), "STEAM_ID_PENDING"]));
  assert.equal(parsed.mapName, "shutdown2");
  assert.deepEqual(parsed.steamIds, [steam(1), steam(2)]);
  assert.throws(() => parseStatus(status([steam(1)]).replace("1 users", "")), /incomplete/i);
  assert.throws(() => parseStatus(status([steam(1)]).replace("1 active", "8 active")), /incomplete/i);
});
test("only eight unambiguous roster identities count, including preconnected spectators", () => {
  const ids = Array.from({length:8}, (_,i) => String(i));
  const links = Object.fromEntries(ids.map((id,i) => [id, [steam(i+1), steam(i+11)]]));
  assert.equal(rosterPresence(ids, links, new Set(ids.map((_,i) => steam(i+1)))).allPresent, true);
  links["7"] = [steam(1)];
  assert.equal(rosterPresence(ids, links, new Set(ids.map((_,i) => steam(i+1)))).allPresent, false);
});
test("presence reconciliation cannot overwrite newer events or apply an old disconnect", () => {
  const p = new PresenceTracker();
  const token = p.beginQuery("east");
  p.event({serverKey:"east",type:"connect",steamid:steam(1),userid:"10"});
  assert.equal(p.reconcile("east", token, {steamIds:[],mapName:"shutdown2"}), false);
  p.event({serverKey:"east",type:"connect",steamid:steam(1),userid:"11"});
  p.event({serverKey:"east",type:"disconnect",steamid:steam(1),userid:"10"});
  assert.equal(p.get("east").has(steam(1)), true);
  assert.equal(p.get("west").size, 0);
  p.event({serverKey:"east",type:"disconnect",steamid:steam(1),userid:"11"});
  assert.equal(p.get("east").size, 0);
});
test("durable log phase distinguishes prematch from live and rejects incomplete or wrong-map evidence",()=>{
  const text=fs.readFileSync(path.join(__dirname,"../parser/upstream/test/L0522000.log"),"utf8");
  const start=text.indexOf('World triggered "Match_Begins_Now"');
  const cut=text.lastIndexOf("\n",start);
  assert.equal(phaseFromLog(text.slice(0,cut+1),"stowaway2_lg2"),"pregame");
  assert.equal(phaseFromLog(text,"stowaway2_lg2"),"live");
  assert.equal(phaseFromLog(text,"othermap"),"unknown");
  assert.equal(phaseFromLog(text.slice(start),"stowaway2_lg2"),"unknown");
});
