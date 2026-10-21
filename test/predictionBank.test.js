"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
const roster={blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:["off"],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};
function setup(t,user="u"){
 const db=new Database(":memory:");t.after(()=>db.close());let n=0;
 const s=createPredictions({db,config:{predictionsEnabled:false},clock:()=>1000000,logger:{warn:()=>{}}});
 const context=()=>({operationKey:`bank-test:${++n}`,actorId:"owner",reason:"test",now:1000+n});
 const events=[],privateMessages=[],publicMessages=[];
 const message={id:"bank-command",guild:{id:"guild"},author:{id:user,send:async payload=>{events.push("dm");privateMessages.push(payload);}},delete:async()=>events.push("delete"),channel:{send:async payload=>publicMessages.push(payload)}};
 const game=id=>s.store.createMarket({...roster,matchId:id},context());
 const bet=(m,id=user,pick="blue",stake=100)=>s.store.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:id,pick,stake,context:context()});
 const settle=(m,outcome="blue")=>{s.store.closeMarket(m.id,context());return s.store.settleMarket({marketId:m.id,outcome,context:context()});};
 return {s,db,context,message,events,privateMessages,publicMessages,game,bet,settle};
}
const body=payload=>payload.content||payload.files?.[0]?.attachment.toString();

test("bank deletes the guild command and privately grants once, with points as an identical self-only alias",async t=>{
 const {s,db,message,events,privateMessages,publicMessages,context}=setup(t);
 const reg=new Map();require("../predictions/bank").register(reg,s);assert.equal(reg.get("bank"),reg.get("points"));
 s.store.adjust("SECRET_OTHER",9000,context());await reg.get("bank")(message,["SECRET_OTHER"]);
 assert.deepEqual(events,["delete","dm"]);const text=body(privateMessages[0]);assert.match(text,/Available:.*1,000/);assert.match(text,/Held in active bets:.*0/);assert.match(text,/Bet limit:.*100/);assert.match(text,/No bets yet/);assert.match(text,/No settled prediction games played yet/);assert.doesNotMatch(text,/SECRET_OTHER|10,000/);
 await reg.get("points")(message);assert.equal(s.store.account("u").balance,1000);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_transactions WHERE account_id='u' AND kind='grant'").get().n,1);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
});
test("bank shows only the caller's last five bets while reserved points include all active stakes",async t=>{
 const {s,message,privateMessages,game,bet}=setup(t);
 for(let i=0;i<6;i++)bet(game(`BET_${i}`));const other=game("SECRET_OTHER");bet(other,"someone-else","red");
 await s.handleBankCommand(message);const text=body(privateMessages[0]);
 assert.match(text,/Available:.*400/);assert.match(text,/Held in active bets:.*600/);assert.match(text,/Total points:.*1,000/);
 assert.doesNotMatch(text,/BET_0|SECRET_OTHER|someone-else/);for(let i=1;i<6;i++)assert.match(text,new RegExp(`BET_${i}`));assert.ok(text.indexOf("BET_5")<text.indexOf("BET_4"));
});
test("bank explains settled returns, retained correction credits, cancellations, refunds and held closed bets",async t=>{
 const {s,message,privateMessages,game,bet,settle,context}=setup(t);
 const completed=game("PAID");bet(completed);bet(completed,"other","red");settle(completed);
 s.store.correctSettlement({marketId:completed.id,outcome:"red",context:context()});s.store.markReview(completed.id,"result changed");
 const held=game("HELD");bet(held);s.store.closeMarket(held.id,context());
 const cancelled=game("CANCELLED");bet(cancelled);s.store.cancelBet({marketRef:{marketId:cancelled.id,revision:1},discordId:"u",context:context()});
 const refunded=game("REFUNDED");bet(refunded);s.store.voidMarket({marketId:refunded.id,context:context()});
 await s.handleBankCommand(message);const text=body(privateMessages[0]);
 assert.match(text,/Available:.*970/);assert.match(text,/Held in active bets:.*100/);assert.match(text,/Bet limit:.*110/);
 assert.match(text,/PAID.*returned 170.*net \+70.*review/i);assert.match(text,/HELD.*held.*closed/i);assert.match(text,/CANCELLED.*cancelled.*refunded 100/i);assert.match(text,/REFUNDED.*refunded 100/i);
});
test("bank lists the last five settled official-player rewards including zero, without counting grants or corrections twice",async t=>{
 const {s,message,privateMessages,game,bet,settle,context}=setup(t,"b1");let corrected;
 for(let i=0;i<6;i++){const m=game(`PLAY_${i}`);if(i<5){bet(m,"spectator","blue");bet(m,"other","red");}settle(m);if(i===1)corrected=m;}
 s.store.correctSettlement({marketId:corrected.id,outcome:"red",context:context()});s.store.markReview(corrected.id,"changed result");s.store.adjust("b1",99,context());
 await s.handleBankCommand(message);const text=body(privateMessages[0]);
 assert.match(text,/No bets yet/);assert.match(text,/Bet limit:.*100/);assert.doesNotMatch(text,/PLAY_0/);for(let i=1;i<6;i++)assert.match(text,new RegExp(`PLAY_${i}`));
 assert.match(text,/PLAY_5.*\+0 points received/);assert.match(text,/PLAY_1.*\+7 points received.*review/);assert.ok(text.indexOf("PLAY_5")<text.indexOf("PLAY_4"));
 const off={...message,author:{id:"off",send:async payload=>privateMessages.push(payload)}};await s.handleBankCommand(off);assert.match(body(privateMessages.at(-1)),/No settled prediction games played yet/);
});
test("bank handles blocked DMs, missing delete permissions and direct messages without exposing financial output",async t=>{
 const {s,message,privateMessages,publicMessages}=setup(t);
 message.delete=async()=>{throw new Error("Missing permissions");};await s.handleBankCommand(message);assert.match(body(privateMessages[0]),/1,000/);assert.equal(publicMessages.length,0);
 message.author.send=async()=>{throw new Error("DM blocked private-payload");};await s.handleBankCommand(message);assert.equal(publicMessages.length,1);assert.match(body(publicMessages[0]),/DM/i);assert.doesNotMatch(JSON.stringify(publicMessages),/1,000|balance|stake|private-payload|bank-test/);
 message.guild=null;let deletions=0;message.delete=async()=>{deletions++;};message.author.send=async payload=>privateMessages.push(payload);await s.handleBankCommand(message);assert.equal(deletions,0);assert.match(body(privateMessages.at(-1)),/1,000/);
});

test("bank attaches long histories privately and shows a losing bettor's zero return",async t=>{
 const {s,message,privateMessages,publicMessages,game,bet,settle}=setup(t);
 for(let i=0;i<5;i++){
  const m=game(`LONG_${i}_${"x".repeat(300)}`);bet(m,"u","red");bet(m,"other","blue");settle(m);
 }
 await s.handleBankCommand(message);const payload=privateMessages[0];
 assert.equal(payload.content,"Your private prediction bank statement.");assert.equal(payload.files[0].name,"prediction-bank.txt");
 const text=payload.files[0].attachment.toString();assert.match(text,/returned 0 \(net -100\)/);assert.match(text,/Available:.*500/);assert.match(text,/Bet limit:.*150/);assert.equal(publicMessages.length,0);
});

test("bank query failures expose no partial statement or internal error",async t=>{
 const {s,message,privateMessages,publicMessages}=setup(t);
 s.store.bettingProgress=()=>{throw new Error("sensitive SQL details");};
 await s.handleBankCommand(message);assert.match(privateMessages[0].content,/could not be loaded/);assert.doesNotMatch(JSON.stringify(privateMessages),/sensitive|SQL|1,000/);
 assert.equal(s.store.account("u"),undefined);assert.equal(publicMessages.length,0);
});
