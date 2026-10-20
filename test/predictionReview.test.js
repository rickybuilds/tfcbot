"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
const {PresenceTracker}=require("../predictions/presence");
const {phaseFromLog}=require("../predictions/phase");
const roster={matchId:"MATCH1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};
function setup(t){let now=1000;const db=new Database(":memory:");const s=createPredictions({db,config:{predictionsEnabled:true,predictionsOwnerId:"owner"},clock:()=>now,queryServerRoster:async()=>({complete:true,mapName:"shutdown2",steamIds:[]})});const m=s.onMatchFinalized(roster);t.after(()=>{s.stop();db.close();});return {s,db,m,time:n=>now=n};}
test("early official result is durably frozen before a crash and cannot settle on later startup",async t=>{
 const {s,db,m,time}=setup(t);db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT)");
 s.store.startCountdown(m.id,1000);time(30000);db.transaction(()=>{db.prepare("INSERT INTO matches VALUES ('MATCH1','BLUE','completed')").run();s.observeOfficialResult({matchId:"MATCH1",outcome:"blue"});})();
 assert.equal(s.store.market(m.id).state,"review_required");time(130000);await s.initialize();assert.equal(s.store.market(m.id).state,"review_required");assert.equal(s.store.market(m.id).settlement_version,0);
});
test("authoritative polling preserves session IDs and delayed connects cannot resurrect departed sessions",()=>{
 const p=new PresenceTracker(),id="STEAM_0:1:1";
 p.event({serverKey:"east",type:"connect",steamid:id,userid:"11"});
 p.reconcile("east",p.beginQuery("east"),{mapName:"shutdown2",steamIds:[id],sessions:[{steamId:id,userid:"11"}]});
 p.event({serverKey:"east",type:"disconnect",steamid:id,userid:"10"});assert.equal(p.get("east").has(id),true);
 p.event({serverKey:"east",type:"disconnect",steamid:id,userid:"11"});
 p.event({serverKey:"east",type:"connect",steamid:id,userid:"11"});assert.equal(p.get("east").has(id),false);
});
test("same-map halftime reload does not erase durable competitive-start evidence",()=>{
 const text='L 10/20/2026 - 10:00:00: Started map "shutdown2"\nL 10/20/2026 - 10:01:00: World triggered "Match_Begins_Now"\nL 10/20/2026 - 10:16:00: Started map "shutdown2"\n';
 assert.equal(phaseFromLog(text,"shutdown2"),"live");
});
function recapHarness(t,s,db,{failFetch=false}={}) {
 const {state}=require("../lib/state"),{attachAutoRecap,armed}=require("../services/autoRecap");
 const oldPred=state.predictions,oldMatches=state.matches;state.predictions=s;state.matches=[{id:"MATCH1",team1Starts:"offense"}];
 const channel={send:async()=>({id:"new-card",channelId:"pickup"})};
 const recap=attachAutoRecap({client:{channels:{cache:{get:()=>channel},fetch:async()=>{if(failFetch)throw new Error("Discord down");return channel;}}},matchesStore:{db}},{recorder:{reconcileAll:async()=>{}},runRconCommand:async()=>{},startVoiceBots:async()=>{},stopVoiceBots:async()=>{}});
 recap.armFromMatchReady({matchId:"MATCH1",map:"shutdown2",serverIp:"east",team1Starts:"offense"});
 t.after(()=>{clearTimeout(armed.get("east")?.timeout);armed.delete("east");state.predictions=oldPred;state.matches=oldMatches;});return {recap,armed,state};
}
test("starting-order change uses the current roster after an awaited phase query",async t=>{
 const {s,db}=setup(t),{recap}=recapHarness(t,s,db);let resume;
 s.queryServerPhase=()=>new Promise(r=>{resume=r;});const pending=recap.updateTeam1Starts("defense","MATCH1");
 const updated={...roster,blueIds:["new","b2","b3","b4"]};s.applyRosterChange({matchId:"MATCH1",nextSnapshot:updated,applyMatchWrites:()=>{}});
 resume({phase:"pregame"});await pending;assert.deepEqual(s.store.latest("MATCH1").snapshot.blueIds,updated.blueIds);
});
test("Discord publication failure cannot separate accepted prediction and armed starting orders",async t=>{
 const {s,db}=setup(t),{recap,armed,state}=recapHarness(t,s,db,{failFetch:true});s.queryServerPhase=async()=>({phase:"pregame"});
 await recap.updateTeam1Starts("defense","MATCH1").catch(()=>{});
 assert.equal(s.store.latest("MATCH1").snapshot.team1Starts,"defense");assert.equal(armed.get("east").team1Starts,"defense");assert.equal(state.matches[0].team1Starts,"defense");
});
test("match audit includes every revision and the original refunded stake",async t=>{
 const {s,m}=setup(t);s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});
 s.store.voidMarket({marketId:m.id,context:s.context("void","owner","teams changed")});s.store.createMarket({...roster,blueIds:["new","b2","b3","b4"]},s.context());
 let payload;await s.handleAdminCommand({author:{id:"owner",send:async p=>{payload=p;}}},["audit","MATCH1"]);
 const data=JSON.parse(payload.files[0].attachment.toString());assert.equal(data.markets.length,2);assert.ok(data.transactions.some(r=>r.market_id===m.id&&r.kind==="refund"));
});
test("repeated pregame resets preserve the match log anchor for later phase checks",t=>{
 const {s,m}=setup(t);s.onHldsEvent({type:"map",name:"shutdown2",serverKey:"east",logInstance:"logs/L1020000.log"});
 s.applyRosterChange({matchId:"MATCH1",nextSnapshot:{...roster,blueIds:["new","b2","b3","b4"]},applyMatchWrites:()=>{}});
 assert.equal(JSON.parse(s.store.latest("MATCH1").phase_evidence).anchorLogInstance,"logs/L1020000.log");
});
test("failed publication remains durable and can be retried after restart",async t=>{
 const {s,m}=setup(t);s.queueCardPublication(m.id,"pickup");
 s.client={channels:{fetch:async()=>({id:"pickup",send:async()=>({id:"recovered-card",channelId:"pickup"})})}};
 await s.retryPendingCards();assert.equal(s.store.market(m.id).message_id,"recovered-card");
});
test("all eight on the assigned server count before the selected map loads",async t=>{
 const {s,m}=setup(t);const links={};const steamIds=[];[...roster.blueIds,...roster.redIds].forEach((id,i)=>{links[id]=[`STEAM_0:1:${i}`];steamIds.push(`STEAM_0:1:${i}`);});
 s.db.prepare("UPDATE prediction_markets SET snapshot=? WHERE id=?").run(JSON.stringify({...roster,steamIdsByDiscordId:links}),m.id);
 s.queryServerRoster=async()=>({complete:true,mapName:"lobby",steamIds});await s.reconcileServer("east");assert.equal(s.store.market(m.id).state,"countdown");assert.equal(s.store.market(m.id).closes_at,121000);
});
test("publishing betting controls does not delay existing match arming on a slow roster query",async t=>{
 const {s,m}=setup(t);let release;s.queryServerRoster=()=>new Promise(r=>{release=r;});
 const posted=require("../predictions/integration").postMatchCard(s,m,{id:"pickup",send:async()=>({id:"card",channelId:"pickup"})},{});
 try{const ready=await Promise.race([posted.then(()=>true),new Promise(r=>setTimeout(()=>r(false),50))]);assert.equal(ready,true);}finally{release?.({complete:true,mapName:"shutdown2",steamIds:[]});await posted;await s.inflight.get("east");}
});
