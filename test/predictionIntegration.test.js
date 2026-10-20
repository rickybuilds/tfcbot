"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){
 const db=new Database(":memory:");t.after(()=>db.close());
 db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,blue_ids TEXT,red_ids TEXT,offense_ids TEXT,team_scenarios TEXT,map_name TEXT,server_name TEXT,mode TEXT,status TEXT,avg_blue INTEGER,avg_red INTEGER,winner TEXT); CREATE TABLE ratings(player_id TEXT PRIMARY KEY,display_name TEXT,rating INTEGER)");
 const ids=Array.from({length:8},(_,i)=>String(100000000000000+i));
 db.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("MATCH1",JSON.stringify(ids.slice(0,4)),JSON.stringify(ids.slice(4)),null,null,"shutdown2","TFC East US Server","CAPTAINS","in_progress",1941,1941,null);
 for(const id of [...ids,"999999999999999"])db.prepare("INSERT INTO ratings VALUES (?,?,1941)").run(id,id);
 const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>1000,queryServerPhase:async()=>({phase:"pregame",logInstance:"test-log"}),queryServerRoster:async()=>({complete:true,mapName:"shutdown2",steamIds:[]})});
 const row=db.prepare("SELECT * FROM matches").get();const m=s.onMatchFinalized(s.snapshotFromRow(row));
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("bet","spectator")});
 const state={matches:[{id:"MATCH1",status:"in_progress"}],maps:[],adlMaps:[],lockedPlayers:new Map(ids.map(id=>[id,"MATCH1"])),predictions:s};
 const sent=[],channel={id:"pickup",send:async p=>{sent.push(p);return {id:"msg",channelId:"pickup"};}};
 const message={author:{id:"admin",tag:"admin"},channel,reply:async p=>sent.push(p),member:{roles:{cache:{has:()=>true}}},guild:{members:{cache:{find:()=>null}},channels:{cache:new Map()}},client:{channels:{fetch:async()=>({...channel,isTextBased:()=>true})}}};
 const deps={state,elo:{db,getDisplayName:(_id,name)=>name,getRating:()=>1941},config:{roles:{admin:"admin"},channels:{pickup:"pickup"}},settings:{getString:()=>"offense"},matchesStore:{findById:()=>({id:"MATCH1"})},predictions:s};
 return {s,db,ids,m,state,message,deps,sent};
}
test("setmap commits a refund/reset with changed terms and no-op changes preserve stakes",async t=>{
 process.env.ADMIN_ROLE_ID="admin";const {s,db,m,message,deps}=setup(t),reg=new Map();
 await require("../commands/setmap").register(reg,deps);
 await reg.get("setmap")(message,["MATCH1","shutdown2"]);assert.equal(s.store.account("spectator").balance,900);
 await reg.get("setmap")(message,["MATCH1","openfire"]);assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.latest("MATCH1").revision,2);assert.equal(db.prepare("SELECT map_name FROM matches").get().map_name,"openfire");
});
test("captain substitution keeps team assignment and atomically rolls back locks and financials on failure",async t=>{
 process.env.ADMIN_ROLE_ID="admin";const {s,db,ids,m,state,message,deps}=setup(t);
 db.exec("CREATE TRIGGER injected BEFORE UPDATE ON prediction_bets WHEN NEW.status='refunded' BEGIN SELECT RAISE(ABORT,'injected'); END");
 await assert.rejects(require("../commands/sub").run(message,[ids[0],"999999999999999","MATCH1"],deps),/injected/);
 assert.equal(state.lockedPlayers.get(ids[0]),"MATCH1");assert.equal(state.lockedPlayers.has("999999999999999"),false);assert.equal(s.store.account("spectator").balance,900);
 assert.deepEqual(JSON.parse(db.prepare("SELECT blue_ids FROM matches").get().blue_ids),ids.slice(0,4));
 db.exec("DROP TRIGGER injected");await require("../commands/sub").run(message,[ids[0],"999999999999999","MATCH1"],deps);
 assert.deepEqual(JSON.parse(db.prepare("SELECT blue_ids FROM matches").get().blue_ids),["999999999999999",...ids.slice(1,4)]);assert.equal(s.store.account("spectator").balance,1000);
});
test("shuffle resets the final teams; stale original snapshots cannot overwrite a newer edit",async t=>{
 const {s,db,ids,message,deps}=setup(t);
 const scenarios={version:1,selected:1,scenarios:[{blue:ids.slice(0,4),red:ids.slice(4)},{blue:ids.slice(4),red:ids.slice(0,4)}]};
 db.prepare("UPDATE matches SET team_scenarios=?").run(JSON.stringify(scenarios));
 await require("../commands/shuffle").execute(message,["MATCH1","2"],deps);
 assert.deepEqual(s.store.latest("MATCH1").snapshot.blueIds,ids.slice(4));assert.equal(s.store.account("spectator").balance,1000);
 const {commitMatchTerms}=require("../predictions/integration");const row=db.prepare("SELECT * FROM matches").get();db.prepare("UPDATE matches SET map_name='newmap'").run();
 assert.throws(()=>commitMatchTerms({db,predictions:s,row,next:{...row,map_name:"other"},write:()=>{throw new Error("should not write");}}),/changed/i);
});
test("finalization persists match and market before publishing buttons and stops on persistence failure",async t=>{
 const {s,db,ids,state,deps}=setup(t);
 s.store.voidMarket({marketId:s.store.latest("MATCH1").id,context:s.context("cleanup","system","test")});
 db.exec("ALTER TABLE matches ADD COLUMN created_at INTEGER; ALTER TABLE matches ADD COLUMN rng_multiplier REAL; ALTER TABLE matches ADD COLUMN bonus_elo TEXT");
 state.queueSnapshot=ids.map(id=>({id,name:id}));state.queue=[...state.queueSnapshot];state.offenseQueue=[];state.lockedServers=new Set();state.lockedPlayers=new Map();
 let published=0;const channel={id:"pickup",send:async payload=>{
   if(payload.embeds?.[0]?.data?.title?.startsWith("Match Ready")){
    published++;assert.ok(db.prepare("SELECT 1 FROM matches WHERE match_id='NEW123'").get());assert.ok(s.store.latest("NEW123"));assert.equal(payload.components.length,1);
   }
   return {id:`card${published}`,channelId:"pickup"};
 }};
 const reg={persistQueueSoon:()=>{}};
 const finalize=()=>require("../commands/voteFlow").finalizeMatch(channel,reg,deps.settings,state,{name:"TFC East US Server",ip:"east"},{name:"shutdown2",mirv:0},deps.elo,{},deps.matchesStore,deps.config,"STANDARD",{},"NEW123");
 await finalize();assert.equal(published,1);
 s.store.voidMarket({marketId:s.store.latest("NEW123").id,context:s.context("cleanup","system","test")});
 state.queueSnapshot=ids.map(id=>({id,name:id}));
 db.exec("CREATE TRIGGER fail_finalize BEFORE INSERT ON matches BEGIN SELECT RAISE(ABORT,'persistence failure'); END");
 await assert.rejects(finalize(),/persistence failure/);assert.equal(published,1);
});
test("a substitute locked elsewhere during phase verification cannot alter roster or escrow",async t=>{
 process.env.ADMIN_ROLE_ID="admin";const {s,db,ids,state,message,deps}=setup(t);
 s.queryServerPhase=async()=>{state.lockedPlayers.set("999999999999999","OTHER1");return {phase:"pregame"};};
 await assert.rejects(require("../commands/sub").run(message,[ids[0],"999999999999999","MATCH1"],deps),/locked/);
 assert.deepEqual(JSON.parse(db.prepare("SELECT blue_ids FROM matches").get().blue_ids),ids.slice(0,4));assert.equal(s.store.account("spectator").balance,900);
});
