"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
test("settlement queues a private owner receipt once and retries failed delivery",async t=>{
 const db=new Database(":memory:");t.after(()=>db.close());const sent=[];let fail=true;
 const s=createPredictions({db,config:{predictionsOwnerId:"owner"},client:{users:{fetch:async id=>{assert.equal(id,"owner");return {send:async payload=>{if(fail)throw Error("blocked");sent.push(payload);}};}}},clock:()=>1000,logger:{warn(){}}});
 const snapshot={matchId:"M",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],mapName:"map",serverKey:"east"};
 const m=s.store.createMarket(snapshot,s.context());
 for(const [id,pick] of [["winner","blue"],["loser","red"]])s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:id,pick,stake:100,context:s.context("bet",id)});
 s.store.closeMarket(m.id,s.context());s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context()});
 await s.deliverSettlementReceipts();assert.equal(sent.length,0);assert.ok(s.store.metadata(`settlement_receipt:${m.id}:1`));
 fail=false;await s.deliverSettlementReceipts();assert.equal(sent.length,1);assert.match(sent[0].content,/winner.*BLUE.*170.*\+70/i);assert.match(sent[0].content,/loser.*RED.*0.*-100/i);
 await s.deliverSettlementReceipts();assert.equal(sent.length,1);assert.equal(s.store.assertAccounting(),true);
 s.store.correctSettlement({marketId:m.id,outcome:"red",context:{...s.context("correct","owner"),reason:"corrected"}});
 await s.deliverSettlementReceipts();assert.equal(sent.length,2);assert.match(sent[1].content,/correction #2/);assert.match(sent[1].content,/loser.*RED.*170.*\+70.*new credit \+170/i);assert.match(sent[1].content,/winner.*BLUE.*170.*\+70.*new credit \+0/i);
 await s.deliverSettlementReceipts();assert.equal(sent.length,2);assert.equal(s.store.assertAccounting(),true);
});
test("failed settlement does not queue a receipt",t=>{
 const db=new Database(":memory:");t.after(()=>db.close());const s=createPredictions({db,config:{predictionsOwnerId:"owner"},clock:()=>1000});
 const m=s.store.createMarket({matchId:"M",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],mapName:"map",serverKey:"east"},s.context());
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});s.store.closeMarket(m.id,s.context());
 db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON prediction_meta WHEN NEW.key GLOB 'settlement_receipt:*' BEGIN SELECT RAISE(ABORT,'failed'); END");
 assert.throws(()=>s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context()}),/failed/);assert.equal(s.store.market(m.id).state,"closed");assert.equal(s.store.account("u").balance,900);assert.equal(s.store.assertAccounting(),true);
});
