"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {calculatePayouts,multipliers}=require("../predictions/payouts");
const Database=require("better-sqlite3"),{PredictionStore}=require("../predictions/store");
const teams={blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],eloOdds:{blue:58,red:42}};
test("version 4 pays frozen odds and fixed player rewards independently of the pot",()=>{
 const p=calculatePayouts({...teams,ruleVersion:4,outcome:"red",bets:[{discord_id:"u",pick:"red",stake:170}]});
 assert.equal(p.credits.u,304); assert.equal(p.credits.r1,20); assert.equal(p.credits.b1,5);
 assert.equal(p.houseFunding,234); assert.equal(p.houseTake,0);
});
test("settlement and corrections fund differences once and conserve accounting",t=>{
 const db=new Database(":memory:");t.after(()=>db.close());const s=new PredictionStore(db);let n=0;
 const ctx=()=>({operationKey:`odds:${++n}`,actorId:"owner",reason:"test",now:100});
 const m=s.createMarket({...teams,matchId:"M",serverKey:"east",mapName:"map"},ctx(),4);
 s.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:"u",pick:"red",stake:100,context:ctx()});
 s.closeMarket(m.id,ctx());s.settleMarket({marketId:m.id,outcome:"red",context:ctx()});
 assert.equal(s.account("u").balance,1079);assert.equal(s.houseFunding(),179);assert.equal(s.assertAccounting(),true);
 s.settleMarket({marketId:m.id,outcome:"red",context:ctx()});assert.equal(s.houseFunding(),179);
 s.correctSettlement({marketId:m.id,outcome:"blue",context:ctx()});assert.equal(s.houseFunding(),239);assert.equal(s.assertAccounting(),true);
 s.correctSettlement({marketId:m.id,outcome:"red",context:ctx()});assert.equal(s.houseFunding(),239);assert.equal(s.assertAccounting(),true);
});
test("version 4 pays players with no bets and ties return twice the stake",()=>{
 const p=calculatePayouts({...teams,ruleVersion:4,outcome:"tie",bets:[{discord_id:"u",pick:"tie",stake:7}]});
 assert.equal(p.credits.u,14); assert.equal(p.credits.b1,10); assert.equal(p.houseFunding,87);
 const empty=calculatePayouts({...teams,ruleVersion:4,outcome:"blue",bets:[]});
 assert.equal(empty.credits.b1,20);assert.equal(empty.credits.r1,5);assert.equal(empty.houseFunding,100);
});
test("multipliers use displayed whole percentages, round to cents and cap extremes",()=>{
 assert.deepEqual(multipliers({blue:52,red:48}),{blue:144,red:156,tie:200});
 assert.deepEqual(multipliers({blue:100,red:0}),{blue:125,red:300,tie:200});
 assert.throws(()=>multipliers({blue:52,red:47}),/odds/i);
 const p=calculatePayouts({...teams,ruleVersion:4,outcome:"blue",bets:[{discord_id:"u",pick:"red",stake:200}]});
 assert.equal(p.credits.u,undefined);assert.equal(p.credits.b1,20);assert.equal(p.houseTake,100);assert.equal(p.houseFunding,0);
});
