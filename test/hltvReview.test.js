"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { privateChannel } = require("../services/hltvReviewAlerts");
const { PermissionFlagsBits: P } = require("discord.js");
const entry = (id, type, allow = 0n, deny = 0n) => ({ id, type,
  allow: { has: b => (allow & b) !== 0n }, deny: { has: b => (deny & b) !== 0n } });
const channel = entries => ({ guildId: "guild", permissionOverwrites: { cache: new Map(entries.map(x => [x.id, x])) } });
test("alerts require private channel with explicit approved members", () => {
  const base = [entry("guild", 0, 0n, P.ViewChannel), entry("123", 1, P.ViewChannel)];
  assert.equal(privateChannel(channel(base), new Set(["123"]), "bot"), true);
  assert.equal(privateChannel(channel([]), new Set(["123"]), "bot"), false);
  assert.equal(privateChannel(channel([...base, entry("other", 1, P.ViewChannel)]), new Set(["123"]), "bot"), false);
  assert.equal(privateChannel(channel([...base, entry("role", 0, P.ViewChannel)]), new Set(["123"]), "bot"), false);
});
test("handoff is opt-in and completed files survive legacy ZIP cleanup", t => {
  const fs=require("fs"),os=require("os"),path=require("path");
  const {createHandoff,finalizeDemo,publishHandoff}=require("../services/hltvHandoff");
  const {cleanupResult}=require("../services/hltvFetch");
  assert.equal(createHandoff({matchId:"1"},{}),null);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"hltv-handoff-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const handoff=createHandoff({matchId:"match1",server:"east",mapName:"2fort"},{HLTV_REGISTRY_ENABLED:"true",HLTV_STORAGE_ROOT:root,HLTV_MIN_DISK_FREE_BYTES:"0"});
  const local=path.join(handoff.dir,"round.dem");fs.writeFileSync(local,"complete");
  assert.throws(()=>finalizeDemo(handoff,local,{size:999,name:"round.dem",modifyTime:1}));
  assert.equal(fs.existsSync(path.join(handoff.dir,"ready.json")),false);
  finalizeDemo(handoff,local,{size:8,name:"round.dem",modifyTime:1});
  assert.equal(fs.existsSync(path.join(handoff.dir,"ready.json")),false);
  publishHandoff(handoff);
  const zip=path.join(handoff.dir,"test.zip");fs.writeFileSync(zip,"zip");
  cleanupResult({tmpDir:handoff.dir,zipPath:zip,retained:true});
  assert.equal(fs.existsSync(local),true);assert.equal(fs.existsSync(zip),false);
  const manifest=JSON.parse(fs.readFileSync(path.join(handoff.dir,"ready.json")));
  assert.equal(manifest.match_id,"match1");assert.equal(manifest.demos[0].round_id,null);
});
