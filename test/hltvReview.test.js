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

function completedDemo() {
  const data=Buffer.alloc(544+32+4+92);data.write("HLDEMO");data.write("schtop",16);data.write("tfc",276);data.writeInt32LE(576,540);data.writeInt32LE(1,576);data.writeInt32LE(544,580+84);data.writeInt32LE(32,580+88);return data;
}
test("remote finalization inspection distinguishes unfinished, changed and finalized source demos without downloading bodies",async()=>{
  const {probeRemoteDemo}=require("../services/hltvFinalization"),complete=completedDemo(),ranges=[];
  let data=Buffer.from(complete),changed=false;
  const sftp={stat:async()=>({size:data.length,modifyTime:changed?2:1,isFile:true}),get:async(name,dst,options)=>{const {start,end}=options.readStreamOptions;ranges.push([start,end]);return Buffer.from(data.subarray(start,end+1));}};
  data.writeInt32LE(0,540);let result=await probeRemoteDemo(sftp,"round.dem","schtop");assert.equal(result.reason,"unfinalized_demo");assert.equal(result.finalized,false);assert.deepEqual(ranges,[[0,543]]);
  data=Buffer.from(complete);ranges.length=0;result=await probeRemoteDemo(sftp,"round.dem","schtop");assert.equal(result.finalized,true);assert(ranges.every(([start,end])=>start>=576||end<544));
  result=await probeRemoteDemo(sftp,"round.dem","other");assert.equal(result.reason,"wrong_map");
  data.writeInt32LE(9999,580+88);result=await probeRemoteDemo(sftp,"round.dem","schtop");assert.equal(result.reason,"invalid_demo_directory");
  data=Buffer.from(complete);sftp.get=async(name,dst,options)=>{changed=true;return data.subarray(options.readStreamOptions.start,options.readStreamOptions.end+1);};
  result=await probeRemoteDemo(sftp,"round.dem","schtop");assert.equal(result.reason,"source_changed");
});

test("finalization waiting is bounded and performs no full downloads while a recording remains open",async()=>{
  const {waitForFinalized,finalizationConfig}=require("../services/hltvFinalization");let time=0,reads=0;
  const data=completedDemo();data.writeInt32LE(0,540);
  const sftp={stat:async()=>({size:data.length,modifyTime:1,isFile:true}),get:async(name,dst,options)=>{reads++;return data.subarray(options.readStreamOptions.start,options.readStreamOptions.end+1);}};
  assert.equal(finalizationConfig({}).enabled,false);
  await assert.rejects(waitForFinalized(sftp,"round.dem","schtop",{timeoutMs:10,pollMs:5,now:()=>time,sleep:async ms=>{time+=ms;}}),/HLTV_NOT_FINALIZED/);
  assert.equal(time,10);assert.equal(reads,3);
  time=0;reads=0;const result=await waitForFinalized(sftp,"round.dem","schtop",{timeoutMs:10,pollMs:5,now:()=>time,sleep:async ms=>{time+=ms;data.writeInt32LE(576,540);}});assert.equal(result.finalized,true);assert.equal(time,5);
});

test("download verification rejects changed bytes and collection uses only one finalized full download",async t=>{
  const fs=require("fs"),os=require("os"),path=require("path"),Sftp=require("ssh2-sftp-client");
  const {fetchAndZipRecentDemos}=require("../services/hltvFetch"),{verifyDownloaded}=require("../services/hltvFinalization");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"hltv-finalization-"));
  t.after(()=>{const safe=fs.realpathSync(root);assert.equal(path.dirname(safe),fs.realpathSync(os.tmpdir()));assert(path.basename(safe).startsWith("hltv-finalization-"));fs.rmSync(safe,{recursive:true,force:true});});
  const values={HLTV_REGISTRY_ENABLED:"true",HLTV_STORAGE_ROOT:root,HLTV_MIN_DISK_FREE_BYTES:"0",HLTV_FINALIZATION_CHECK_ENABLED:"true",HL_SSH_HOST_EAST:"fixture",HL_SSH_USER:"fixture",HL_REMOTE_HLTV_DIR_EAST:"HLTVEAST"};
  const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);t.after(()=>{for(const [key,value]of Object.entries(saved))if(value==null)delete process.env[key];else process.env[key]=value;});
  const data=Buffer.alloc(4_000_100),offset=data.length-96;data.write("HLDEMO");data.write("schtop",16);data.write("tfc",276);data.writeInt32LE(offset,540);data.writeInt32LE(1,offset);data.writeInt32LE(544,offset+4+84);data.writeInt32LE(offset-544,offset+4+88);
  let downloads=0;const ranges=[];
  for(const method of ["connect","end"])t.mock.method(Sftp.prototype,method,async()=>{});
  t.mock.method(Sftp.prototype,"list",async()=>[{name:"-2611152357-schtop.dem",size:data.length,modifyTime:1}]);
  t.mock.method(Sftp.prototype,"stat",async()=>({size:data.length,modifyTime:1,isFile:true}));
  t.mock.method(Sftp.prototype,"get",async(name,dst,options)=>{ranges.push(options.readStreamOptions);return Buffer.from(data.subarray(options.readStreamOptions.start,options.readStreamOptions.end+1));});
  t.mock.method(Sftp.prototype,"fastGet",async(name,dst)=>{downloads++;fs.writeFileSync(dst,data);});
  const result=await fetchAndZipRecentDemos({matchId:"fixture",server:"east",mapName:"schtop",requiredCount:1});
  assert.equal(downloads,1);assert.equal(result.demos.length,1);assert(fs.existsSync(path.join(result.tmpDir,"ready.json")));assert(ranges.every(({start,end})=>end<544||start>=offset));
  const snapshot={size:data.length,directory_offset:offset,header:data.subarray(0,544),directory:data.subarray(offset)};
  assert.doesNotThrow(()=>verifyDownloaded(result.demos[0].localPath,snapshot));
  const fd=fs.openSync(result.demos[0].localPath,"r+");fs.writeSync(fd,Buffer.from([1]),0,1,540);fs.closeSync(fd);
  assert.throws(()=>verifyDownloaded(result.demos[0].localPath,snapshot),/HLTV_DOWNLOAD_CHANGED_OR_INCOMPLETE/);
  const workdirs=fs.readdirSync(path.join(root,"incoming")).length;data.write("other\0",16);
  await assert.rejects(fetchAndZipRecentDemos({matchId:"wrong",server:"east",mapName:"schtop",requiredCount:1}),/wrong_map/);
  assert.equal(downloads,1);assert.equal(fs.readdirSync(path.join(root,"incoming")).length,workdirs);
});
