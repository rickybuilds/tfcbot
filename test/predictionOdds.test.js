"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions"),{cardUpdate}=require("../predictions/messages");
const snapshot={matchId:"ODDS",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};
function setup(t){
 const db=new Database(":memory:");t.after(()=>db.close());db.exec("CREATE TABLE ratings(player_id TEXT PRIMARY KEY,display_name TEXT,rating INTEGER)");
 for(const id of [...snapshot.blueIds,...snapshot.redIds,"new"])db.prepare("INSERT INTO ratings VALUES(?,?,?)").run(id,id,id==="new"?1500:id.startsWith("b")?2100:1900);
 const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>1000});t.after(()=>s.stop());return {s,db};
}
const labels=m=>cardUpdate(m,1000).components[0].components.map(b=>b.data.label);
test("prediction buttons use the existing actual-team Elo estimate and leave Tie and My Bet unchanged",t=>{
 const {s}=setup(t),m=s.onMatchFinalized(snapshot);
 assert.deepEqual(labels(m),["Blue / Team 1 · 76% · 1.25x","Red / Team 2 · 24% · 3.00x","Tie · 2.00x","My Bet"]);
 const {summarizeSplit}=require("../lib/odds"),ratings=new Map([...snapshot.blueIds.map(id=>[id,2100]),...snapshot.redIds.map(id=>[id,1900])]);
 const odds=summarizeSplit(snapshot.blueIds.map(id=>({id})),snapshot.redIds.map(id=>({id})),ratings);
 assert.deepEqual(m.snapshot.eloOdds,{blue:odds.pctBlue,red:odds.pctRed});
 assert.equal(cardUpdate(m,1000).components[0].components[0].data.custom_id,`pred:pick:${m.id}:1:blue`);
});
test("successful pregame roster changes recompute percentages for the final teams and refund the original bet",t=>{
 const {s}=setup(t),m=s.onMatchFinalized(snapshot);
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("bet","spectator")});
 const sub={...snapshot,blueIds:["b1","b2","b3","new"]};
 const next=s.applyRosterChange({matchId:snapshot.matchId,nextSnapshot:sub,applyMatchWrites:()=>{}});
 assert.deepEqual(labels(next).slice(0,2),["Blue / Team 1 · 57% · 1.32x","Red / Team 2 · 43% · 1.74x"]);assert.equal(s.store.account("spectator").balance,1000);
 const shuffled={...sub,blueIds:["r1","b2","b3","new"],redIds:["b1","r2","r3","r4"]};
 const third=s.applyRosterChange({matchId:snapshot.matchId,nextSnapshot:shuffled,applyMatchWrites:()=>{}});
 assert.deepEqual(labels(third).slice(0,2),["Blue / Team 1 · 43% · 1.74x","Red / Team 2 · 57% · 1.32x"]);assert.equal(s.store.assertAccounting(),true);
});
test("odds remain fixed for a roster revision despite later rating changes or starting team colors",t=>{
 const {s,db}=setup(t),m=s.onMatchFinalized({...snapshot,team1Starts:"defense"});
 db.prepare("UPDATE ratings SET rating=1000 WHERE player_id LIKE 'b%'").run();
 assert.deepEqual(labels(s.store.market(m.id)).slice(0,2),["Blue / Team 1 · 76% · 1.25x","Red / Team 2 · 24% · 3.00x"]);
 s.store.closeMarket(m.id,s.context());const closed=cardUpdate(s.store.market(m.id),1000);
 assert.equal(closed.components[0].components[0].data.label,"Blue / Team 1 · 76% · 1.25x");assert.equal(closed.components[0].components[0].data.disabled,true);
});
test("legacy or invalid estimates retain the original button labels instead of inventing percentages",()=>{
 for(const eloOdds of [undefined,{blue:NaN,red:NaN},{blue:60,red:60},{blue:-1,red:101},{blue:"60",red:40}]){
  const m={id:1,revision:1,state:"open",snapshot:{eloOdds}};
  assert.deepEqual(labels(m),["Blue / Team 1","Red / Team 2","Tie","My Bet"]);
 }
});
