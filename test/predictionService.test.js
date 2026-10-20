"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){let now=1000;const db=new Database(":memory:");const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>now,queryServerRoster:async()=>({mapName:"shutdown2",complete:true,steamIds:Array.from({length:8},(_,i)=>`STEAM_0:1:${i}`)})});t.after(()=>{s.stop();db.close();});const snapshot={matchId:"MATCH1",blueIds:["0","1","2","3"],redIds:["4","5","6","7"],offenseIds:[],steamIdsByDiscordId:Object.fromEntries(Array.from({length:8},(_,i)=>[String(i),[`STEAM_0:1:${i}`]])),serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};return {s,db,snapshot,time:n=>{now=n;}};}
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
