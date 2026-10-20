"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {PredictionStore}=require("../predictions/store");
let seq=0;
const context=()=>({operationKey:`op:${++seq}`,actorId:"owner",reason:"test",now:100});
const snapshot=(matchId="MATCH1")=>({matchId,blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:["off"],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});
function setup(t){const db=new Database(":memory:");t.after(()=>db.close());return new PredictionStore(db);}
function bet(s,m,user,pick,stake){return s.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:user,pick,stake,context:context()});}
test("account grant is once and stake edits replace escrow without exceeding cap",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());
 s.ensureAccount("u",context());s.ensureAccount("u",context());
 bet(s,m,"u","blue",200);bet(s,m,"u","red",250);
 assert.equal(s.account("u").balance,750);assert.equal(s.bets(m.id)[0].stake,250);
 assert.throws(()=>bet(s,m,"u","tie",251),/stake/i);
 s.cancelBet({marketRef:{marketId:m.id,revision:m.revision},discordId:"u",context:context()});
 assert.equal(s.account("u").balance,1000);assert.equal(s.assertAccounting(),true);
});
test("participants, earlier revisions and cross-match spending cannot bypass eligibility or funds",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());
 assert.throws(()=>bet(s,m,"b1","blue",1),/participant/i);
 assert.throws(()=>bet(s,m,"off","blue",1),/participant/i);
 for(let i=0;i<4;i++)bet(s,s.createMarket(snapshot(`M${i}`),context()),"u","blue",250);
 assert.throws(()=>bet(s,m,"u","blue",1),/funds/i);
 const next=snapshot();next.blueIds[0]="new";
 s.voidMarket({marketId:m.id,context:context()});
 const n=s.createMarket(next,context());assert.throws(()=>bet(s,n,"b1","red",10),/participant/i);
 assert.equal(s.assertAccounting(),true);
});
test("deadline is enforced on submit even without timer and replay does not debit twice",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());const ctx=context();
 const input={marketRef:{marketId:m.id,revision:m.revision},discordId:"u",pick:"blue",stake:100,context:ctx};
 s.placeBet(input);s.placeBet(input);assert.equal(s.account("u").balance,900);
 s.startCountdown(m.id,1000);input.context={...context(),now:121000};
 assert.throws(()=>s.placeBet(input),/closed/i);
 assert.throws(()=>s.cancelBet({...input}),/closed/i);
 assert.equal(s.assertAccounting(),true);
});
test("house corrections retain spent and unspent payouts and pay positive differences only",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());
 bet(s,m,"u","blue",200);bet(s,m,"v","red",200);
 s.closeMarket(m.id,context());s.settleMarket({marketId:m.id,outcome:"blue",context:context()});
 assert.equal(s.account("u").balance,1140);
 const old=s.account("u").balance;
 s.adjust("u",-1100,context());
 s.correctSettlement({marketId:m.id,outcome:"red",context:context()});
 assert.equal(s.account("u").balance,old-1100);
 assert.equal(s.account("v").balance,1140);
 const issued=s.houseFunding();
 s.correctSettlement({marketId:m.id,outcome:"blue",context:context()});
 s.correctSettlement({marketId:m.id,outcome:"red",context:context()});
 assert.equal(s.houseFunding(),issued);assert.equal(s.account("v").balance,1140);
 assert.equal(s.assertAccounting(),true);
});
test("no-correct refund is correctable, and duplicate reports never credit twice",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());bet(s,m,"u","blue",250);
 s.closeMarket(m.id,context());s.settleMarket({marketId:m.id,outcome:"tie",context:context()});
 assert.equal(s.account("u").balance,1000);
 s.settleMarket({marketId:m.id,outcome:"tie",context:context()});
 assert.equal(s.account("u").balance,1000);
 s.correctSettlement({marketId:m.id,outcome:"blue",context:context()});
 assert.equal(s.account("u").balance,1000);assert.equal(s.houseFunding(),0);
 assert.equal(s.assertAccounting(),true);
});
test("failed transaction rolls back accounts, bets and ledger together",t=>{
 const s=setup(t),m=s.createMarket(snapshot(),context());
 s.db.exec("CREATE TRIGGER fail_debit BEFORE INSERT ON prediction_transactions WHEN NEW.kind='stake' BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>bet(s,m,"u","blue",100),/injected/);
 assert.equal(s.account("u"),undefined);assert.equal(s.bets(m.id).length,0);assert.equal(s.assertAccounting(),true);
});
module.exports={snapshot,context};
