"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){let now=1000;const db=new Database(":memory:");const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>now,waitForRosterRetry:async()=>{},queryServerRoster:async()=>({mapName:"shutdown2",complete:true,steamIds:Array.from({length:8},(_,i)=>`STEAM_0:1:${i}`)})});t.after(()=>{s.stop();db.close();});const snapshot={matchId:"MATCH1",blueIds:["0","1","2","3"],redIds:["4","5","6","7"],offenseIds:[],steamIdsByDiscordId:Object.fromEntries(Array.from({length:8},(_,i)=>[String(i),[`STEAM_0:1:${i}`]])),serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};return {s,db,snapshot,time:n=>{now=n;}};}
test("all eight start one full countdown that gameplay and disconnects cannot shorten or extend",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot);
 await s.reconcileServer("east");assert.equal(s.store.market(m.id).closes_at,121000);
 time(31000);await s.onHldsEvent({serverKey:"east",type:"prediction_live_start"});
 assert.equal(s.store.market(m.id).state,"countdown");
 await s.onHldsEvent({serverKey:"east",type:"disconnect",steamid:"STEAM_0:1:1",userid:"10"});
 assert.equal(s.store.market(m.id).closes_at,121000);
 time(120999);s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("last-moment","spectator")});
 time(121000);assert.throws(()=>s.store.cancelBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",context:s.context("late","spectator")}),/closed/);
 s.tick();assert.equal(s.store.market(m.id).state,"closed");
});
test("pregame rebalance refunds atomically; live changes never reopen",async t=>{
 const {s,db,snapshot}=setup(t),m=s.onMatchFinalized(snapshot);
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("bet","spectator")});
 const next={...snapshot,blueIds:["new","1","2","3"]};
 assert.throws(()=>s.applyRosterChange({matchId:"MATCH1",nextSnapshot:next,applyMatchWrites:()=>{throw new Error("injected");}}),/injected/);
 assert.equal(s.store.account("spectator").balance,900);assert.equal(s.store.market(m.id).state,"open");
 s.applyRosterChange({matchId:"MATCH1",nextSnapshot:next,applyMatchWrites:()=>{}});
 assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.latest("MATCH1").revision,2);
 await s.onHldsEvent({serverKey:"east",type:"map",name:"shutdown2"});
 await s.onHldsEvent({serverKey:"east",type:"prediction_live_start"});
 s.applyRosterChange({matchId:"MATCH1",nextSnapshot:snapshot,applyMatchWrites:()=>{}});
 assert.equal(s.store.latest("MATCH1").state,"void");assert.equal(s.store.assertAccounting(),true);
});
test("recovery enforces expired deadlines and freezes uncertain open history without new countdown",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot);await s.reconcileServer("east");
 time(130000);await s.initialize();assert.equal(s.store.market(m.id).state,"closed");
 const next={...snapshot,matchId:"MATCH2",serverKey:"west"};const n=s.onMatchFinalized(next);
 await s.initialize();assert.equal(s.store.market(n.id).state,"review_required");
 assert.equal(s.store.market(n.id).closes_at,null);
});
test("changed official results freeze settlement before follow-up failures; duplicate result does not pay twice",t=>{
 const {s,db,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot);
 db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT)");db.prepare("INSERT INTO matches VALUES (?,'BLUE','completed')").run(snapshot.matchId);
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});
 s.store.startCountdown(m.id,1000);time(121000);s.tick();s.observeOfficialResult({matchId:snapshot.matchId,outcome:"blue"});s.onMatchReported({matchId:snapshot.matchId});
 const balance=s.store.account("u").balance;s.onMatchReported({matchId:snapshot.matchId});assert.equal(s.store.account("u").balance,balance);
 s.observeOfficialResult({matchId:snapshot.matchId,outcome:"red"});assert.equal(s.store.market(m.id).state,"review_required");
});
test("wrong-map reconciliation freezes bets and unavailable phase evidence never authorizes reopening",async t=>{
 const {s,snapshot}=setup(t),m=s.onMatchFinalized(snapshot);
 s.onHldsEvent({serverKey:"east",type:"map",name:"shutdown2"});
 s.queryServerRoster=async()=>({complete:true,mapName:"other",steamIds:[]});await s.reconcileServer("east");assert.equal(s.store.market(m.id).state,"review_required");
 s.queryServerPhase=async()=>({phase:"unknown"});await s.prepareTermsChange(snapshot.matchId);
 s.applyRosterChange({matchId:snapshot.matchId,nextSnapshot:{...snapshot,mapName:"other"},applyMatchWrites:()=>{}});assert.equal(s.store.latest(snapshot.matchId).revision,1);assert.equal(s.store.market(m.id).phase,"unknown");
});
test("roster failures identify safe causes without leaking response data or reopening reviewed markets",async t=>{
 const {s,snapshot}=setup(t),m=s.onMatchFinalized(snapshot),warnings=[];
 s.logger={warn:message=>warnings.push(message)};
 for(const [message,reason] of [
  ["Incomplete server status roster","incomplete status roster"],
  ["RCON UDP timeout - server may be busy","RCON timeout"],
  ["RCON error (attempt 1): connect ECONNREFUSED","RCON connection refused"],
  ["unexpected payload secret-password private-player-data","RCON/status query failed"]
 ]){
  s.queryServerRoster=async()=>{throw new Error(message);};
  await s.reconcileServer("east");
  assert.equal(warnings.at(-1),`[predictions] roster reconciliation failed for east: ${reason}`);
  assert.equal(s.store.market(m.id).state,"review_required");
 }
 s.queryServerRoster=async()=>({complete:true,mapName:"shutdown2",steamIds:Object.values(snapshot.steamIdsByDiscordId).flat()});
 await s.reconcileServer("east");
 assert.equal(s.store.market(m.id).state,"review_required");
 assert.equal(s.store.market(m.id).closes_at,null);
});
test("an incomplete roster during selected-map reload retries before freezing and starts a full countdown from fresh evidence",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;
 let calls=0,waits=0;s.logger={warn:()=>{}};
 s.queryServerRoster=async key=>{calls++;if(calls===1)throw new Error("Incomplete server status roster");return query(key);};
 s.waitForRosterRetry=async()=>{
  waits++;assert.equal(s.store.market(m.id).state,"open");assert.equal(s.knownServers.has("east"),false);
  assert.equal(s.store.market(m.id).closes_at,null);
  time(5000);s.onHldsEvent({type:"map",serverKey:"east",name:"shutdown2"});
 };
 await s.reconcileServer("east");
 assert.equal(calls,2);assert.equal(waits,1);
 assert.equal(s.store.market(m.id).state,"countdown");assert.equal(s.store.market(m.id).closes_at,125000);
});
test("roster retry after a reload discards a stale complete response and confirms the current players",async t=>{
 const {s,snapshot}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;let calls=0;
 s.logger={warn:()=>{}};
 s.queryServerRoster=async key=>{calls++;if(calls===1){s.onHldsEvent({type:"map",serverKey:"east",name:"shutdown2"});return query(key);}return {complete:true,mapName:"shutdown2",steamIds:[]};};
 await s.reconcileServer("east");
 assert.equal(calls,2);assert.equal(s.store.market(m.id).state,"open");assert.equal(s.presence.get("east").size,0);
 assert.equal(s.store.market(m.id).closes_at,null);
});
test("transient roster failures cannot extend or reopen a countdown that expires during retry",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;
 await s.reconcileServer("east");const deadline=s.store.market(m.id).closes_at;let calls=0;
 s.logger={warn:()=>{}};
 s.queryServerRoster=async key=>{if(++calls===1)throw new Error("Incomplete server status roster");return query(key);};
 s.waitForRosterRetry=async()=>{time(deadline);s.tick();};await s.reconcileServer("east");
 assert.equal(calls,2);assert.equal(s.store.market(m.id).closes_at,deadline);assert.equal(s.store.market(m.id).state,"closed");
 assert.throws(()=>s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("late","spectator")}),/closed/);
});
test("persistent roster failure exhausts a bounded retry and freezes rather than trusting connect logs",async t=>{
 const {s,snapshot}=setup(t),m=s.onMatchFinalized(snapshot);let calls=0,waits=0;s.logger={warn:()=>{}};
 s.knownServers.add("east");
 s.queryServerRoster=async()=>{calls++;throw new Error("Incomplete server status roster");};
 s.waitForRosterRetry=async()=>{waits++;for(let i=0;i<8;i++)s.onHldsEvent({type:"connect",serverKey:"east",steamid:`STEAM_0:1:${i}`,userid:String(i+1)});};
 await s.reconcileServer("east");
 assert.equal(calls,3);assert.equal(waits,2);assert.equal(s.store.market(m.id).state,"review_required");
 assert.equal(s.store.market(m.id).closes_at,null);assert.equal(s.knownServers.has("east"),false);
});
test("accepted restart checks at 15 seconds, two minutes and minute intervals; eight arrivals still get two full minutes",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;let here=false,calls=0;
 s.queryServerRoster=async key=>{calls++;return here?query(key):{complete:true,mapName:"shutdown2",steamIds:[]};};
 s.onRestartRequested({matchId:snapshot.matchId,serverKey:"east"});
 time(15999);await s.reconcileServer("east");await s.pollRosters();assert.equal(calls,0);
 time(16000);await s.pollRosters();assert.equal(calls,1);assert.equal(s.store.market(m.id).closes_at,null);
 time(120999);await s.pollRosters();assert.equal(calls,1);
 time(121000);await s.pollRosters();assert.equal(calls,2);
 time(181000);await s.pollRosters();assert.equal(calls,3);assert.equal(s.store.market(m.id).state,"open");
 time(301000);here=true;await s.pollRosters();assert.equal(calls,4);
 assert.equal(s.store.market(m.id).closes_at,421000);
});
test("restart cannot defer another server or match, and never extends an existing deadline",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;await s.reconcileServer("east");
 const deadline=s.store.market(m.id).closes_at;let calls=0;s.queryServerRoster=async key=>{calls++;return query(key);};
 s.onRestartRequested({matchId:"other",serverKey:"east"});await s.reconcileServer("east");assert.equal(calls,1);
 s.onRestartRequested({matchId:snapshot.matchId,serverKey:"west"});await s.reconcileServer("east");assert.equal(calls,2);
 time(5000);s.onRestartRequested({matchId:snapshot.matchId,serverKey:"east"});await s.reconcileServer("east");assert.equal(calls,2);
 time(20000);await s.pollRosters();assert.equal(calls,3);assert.equal(s.store.market(m.id).closes_at,deadline);
});
test("a restart during an in-flight query invalidates its result without freezing or starting a countdown",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot);let release;
 s.queryServerRoster=()=>new Promise(resolve=>{release=resolve;});const pending=s.reconcileServer("east");
 time(2000);s.onRestartRequested({matchId:snapshot.matchId,serverKey:"east"});
 release({complete:true,mapName:"shutdown2",steamIds:Object.values(snapshot.steamIdsByDiscordId).flat()});await pending;
 assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.market(m.id).closes_at,null);assert.equal(s.knownServers.has("east"),false);
});
test("connection logs confirm all eight after settling without waiting for the next scheduled poll",async t=>{
 const {s,snapshot,time}=setup(t),m=s.onMatchFinalized(snapshot),query=s.queryServerRoster;let calls=0,here=false;
 s.queryServerRoster=async key=>{calls++;return here?query(key):{complete:true,mapName:"shutdown2",steamIds:[]};};
 s.onRestartRequested({matchId:snapshot.matchId,serverKey:"east"});
 for(let i=0;i<8;i++)s.onHldsEvent({type:"connect",serverKey:"east",steamid:`STEAM_0:1:${i}`,userid:String(i+1)});
 assert.equal(calls,0);assert.equal(s.store.market(m.id).closes_at,null);
 time(16000);await s.pollRosters();assert.equal(calls,1);
 time(31000);here=true;for(let i=0;i<8;i++)await s.onHldsEvent({type:"connect",serverKey:"east",steamid:`STEAM_0:1:${i}`,userid:String(i+11)});
 assert.equal(calls,2);assert.equal(s.store.market(m.id).closes_at,151000);
});
