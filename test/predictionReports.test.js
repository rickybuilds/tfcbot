"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
test("report persists prediction observation before Discord failure; changed ordinary reports require review",async t=>{
 process.env.ADMIN_ROLE_ID="admin";const db=new Database(":memory:");t.after(()=>db.close());
 db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,blue_ids TEXT,red_ids TEXT,offense_ids TEXT,map_name TEXT,server_name TEXT,mode TEXT,rng_multiplier REAL,bonus_elo TEXT,winner TEXT,status TEXT,processed_at INTEGER,hampalyzer_url TEXT,tfcstats_url TEXT)");
 const blue=["b1","b2","b3","b4"],red=["r1","r2","r3","r4"];
 db.prepare("INSERT INTO matches VALUES ('MATCH1',?,?,NULL,'shutdown2','east','STANDARD',1,NULL,NULL,'in_progress',NULL,NULL,NULL)").run(JSON.stringify(blue),JSON.stringify(red));
 const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>130000});const m=s.onMatchFinalized(s.snapshotFromRow(db.prepare("SELECT * FROM matches").get()));
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});s.store.startCountdown(m.id,0);
 const reg=new Map(),state={predictions:s,matches:[{id:"MATCH1",blueTeam:blue.map(id=>({id})),redTeam:red.map(id=>({id}))}]};
 require("../commands/admin").register(reg,{state,predictions:s,config:{channels:{pickup:"pickup",eloAdmin:"admin"}},elo:{db,unreportMatch:()=>{},applyTeamResult:()=>{}},matchesStore:{}});
 const message={internalAutoReport:true,author:{id:"bot"},channel:{id:"pickup",send:async()=>{throw new Error("Discord down");}}};
 await assert.rejects(reg.get("report")(message,["MATCH1","blue","--auto"]),/Discord down/);
 assert.equal(s.store.market(m.id).observed_result,"blue");assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.account("u").balance,1000);
 await assert.rejects(reg.get("report")(message,["MATCH1","red","--auto"]),/Discord down/);assert.equal(s.store.market(m.id).state,"review_required");
});
test("deleting unresolved bets refunds atomically and settled history blocks all database connections",t=>{
 const db=new Database(":memory:");t.after(()=>db.close());db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT)");db.prepare("INSERT INTO matches VALUES ('MATCH1',NULL,'in_progress')").run();
 const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>1000});const m=s.onMatchFinalized({matchId:"MATCH1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});
 assert.throws(()=>db.prepare("DELETE FROM matches").run(),/Resolve prediction/);
 s.applyMatchDeletion({matchId:"MATCH1",applyMatchWrites:()=>db.prepare("DELETE FROM matches").run()});
 assert.equal(s.store.account("u").balance,1000);assert.equal(s.store.market(m.id).state,"void");assert.equal(s.store.assertAccounting(),true);
});
