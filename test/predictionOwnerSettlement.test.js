"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createPredictions}=require('../predictions');
function setup(t){
 let now=1000;const db=new Database(':memory:');t.after(()=>db.close());
 const s=createPredictions({db,config:{predictionsEnabled:false,predictionsOwnerId:'owner'},clock:()=>now});s.refreshCard=async()=>{};
 const snapshot={matchId:'DH96AX',blueIds:['b1','b2','b3','b4'],redIds:['r1','r2','r3','r4'],offenseIds:[],steamIdsByDiscordId:{},serverKey:'east',mapName:'alchimy_lg',team1Starts:'offense'};
 const m=s.store.createMarket(snapshot,s.context('create'));
 for(const [user,pick] of [['a','red'],['b','red'],['c','blue'],['d','blue']])s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:user,pick,stake:100,context:s.context('bet',user)});
 s.store.markReview(m.id,'unexpected server map');
 db.exec('CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT,blue_ids TEXT,red_ids TEXT,map_name TEXT)');
 db.prepare('INSERT INTO matches VALUES (?,?,?,?,?,?)').run('DH96AX','RED','completed',JSON.stringify(snapshot.blueIds),JSON.stringify(snapshot.redIds),snapshot.mapName);
 const messages=[],publicMessages=[];let id=0;
 const message={get id(){return `cmd:${++id}`;},author:{id:'owner',send:async p=>messages.push(p)},channel:{send:async p=>publicMessages.push(p)}};
 const preview=async()=>{await s.handleAdminCommand(message,['settle','DH96AX','red','Verified official Red 90-80; accept frozen bets']);return messages.at(-1);};
 const confirm=async(payload,user='owner')=>{const i={id:`click:${++id}`,customId:payload.components[0].components[0].data.custom_id,user:{id:user},reply:async function(p){this.response=p;}};await s.handleInteraction(i);return i.response;};
 return {s,db,m,message,messages,publicMessages,preview,confirm,time:n=>now=n};
}
test('owner settles a reviewed completed game with missing deadline once, preserving payouts and audit',async t=>{
 const {s,db,m,preview,confirm,publicMessages}=setup(t);const p=await preview();assert.ok(p.components);assert.match(p.content,/400/);assert.match(p.content,/unexpected server map/);assert.match(p.content,/deadline|window/i);
 assert.equal(s.store.account('a').balance,900);await confirm(p);assert.equal(s.store.latest('DH96AX').state,'settled');assert.equal(s.store.latest('DH96AX').result,'red');assert.equal(s.store.latest('DH96AX').closes_at,null);
 assert.equal(s.store.account('a').balance,1070);assert.equal(s.store.account('b').balance,1070);assert.equal(s.store.account('c').balance,900);assert.equal(s.store.bettingProgress('a').settledGames,1);
 const ledger=db.prepare("SELECT * FROM prediction_transactions WHERE kind='owner_settlement'").all();assert.equal(ledger.length,1);assert.equal(ledger[0].actor_id,'owner');assert.match(ledger[0].metadata,/unexpected server map/);assert.match(ledger[0].reason,/Verified/);
 await confirm(p);s.onMatchReported({matchId:'DH96AX'});assert.equal(s.store.latest('DH96AX').settlement_version,1);assert.equal(s.store.account('a').balance,1070);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
 const again=await preview();assert.match(again.content,/settle|previous/i);assert.equal(again.components,undefined);
});
test('settle refuses nonowners, ongoing reports, wrong results and mismatched teams or maps',async t=>{
 const {s,db,message,messages,preview}=setup(t);message.author.id='admin';await preview();assert.match(messages.at(-1).content,/owner/i);message.author.id='owner';
 for(const [sql,params] of [["UPDATE matches SET status=?",['pending']],["UPDATE matches SET status='completed',winner=?",['BLUE']],["UPDATE matches SET winner='RED',blue_ids=?",['["other"]']]]){db.prepare(sql).run(...params);assert.equal((await preview()).components,undefined);}
 db.prepare('UPDATE matches SET blue_ids=?,map_name=?').run(JSON.stringify(['b1','b2','b3','b4']),'wrongmap');assert.equal((await preview()).components,undefined);assert.equal(s.store.latest('DH96AX').state,'review_required');assert.equal(s.store.account('a').balance,900);
});
test('settlement confirmation is owner-bound, expires, and rejects changed official teams or bet inputs',async t=>{
 const {s,db,preview,confirm,time}=setup(t);let p=await preview();assert.ok(p.components);assert.match((await confirm(p,'admin')).content,/owner/i);
 time(61000);assert.match((await confirm(p)).content,/expired/i);time(62000);p=await preview();db.prepare('UPDATE matches SET blue_ids=?').run(JSON.stringify(['b2','b1','b3','changed']));assert.match((await confirm(p)).content,/changed|teams/i);
 db.prepare('UPDATE matches SET blue_ids=?').run(JSON.stringify(['b1','b2','b3','b4']));p=await preview();db.prepare("UPDATE prediction_bets SET pick='blue' WHERE discord_id='a'").run();assert.match((await confirm(p)).content,/changed/i);assert.equal(s.store.latest('DH96AX').state,'review_required');
});
test('settlement cannot revive a voided game and blocked DMs do not pay out',async t=>{
 const {s,m,message,preview,publicMessages}=setup(t);message.author.send=async()=>{throw new Error('blocked');};await preview();assert.equal(s.store.account('a').balance,900);assert.equal(publicMessages.length,0);
 s.store.voidMarket({marketId:m.id,context:s.context('void','owner','refund')});const messages=[];message.author.send=async p=>messages.push(p);await preview();assert.equal(messages[0].components,undefined);assert.equal(s.store.latest('DH96AX').state,'void');assert.equal(s.store.account('a').balance,1000);
});
test('failed payout rolls back recovery state, audit and all credits',async t=>{
 const {s,db,m,preview,confirm}=setup(t);const p=await preview();assert.ok(p.components);db.exec("CREATE TRIGGER fail_payout BEFORE INSERT ON prediction_transactions WHEN NEW.kind='settlement' BEGIN SELECT RAISE(ABORT,'injected payout failure'); END;");
 await confirm(p);assert.equal(s.store.market(m.id).state,'review_required');assert.equal(s.store.market(m.id).closed_at,null);assert.equal(s.store.account('a').balance,900);assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions WHERE kind='owner_settlement'").get().n,0);assert.equal(s.store.assertAccounting(),true);
});
test('separate previews and restart recovery cannot issue a second payout',async t=>{
 const {s,db,preview,confirm}=setup(t),first=await preview(),second=await preview();await confirm(first);assert.match((await confirm(second)).content,/changed/i);
 const restarted=createPredictions({db,config:{predictionsEnabled:false,predictionsOwnerId:'owner'},clock:()=>1000});restarted.refreshCard=async()=>{};
 const i={id:'replayed-after-restart',customId:first.components[0].components[0].data.custom_id,user:{id:'owner'},reply:async()=>{}};await restarted.handleInteraction(i);restarted.onMatchReported({matchId:'DH96AX'});
 assert.equal(s.store.account('a').balance,1070);assert.equal(s.store.latest('DH96AX').settlement_version,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions WHERE kind='allocation'").get().n,1);assert.equal(s.store.assertAccounting(),true);
});
test('tie recovery retains an existing deadline and pays only the normal tie allocation',async t=>{
 const {s,db,m,message,messages,confirm}=setup(t);db.prepare("UPDATE matches SET winner='TIE'").run();db.prepare("UPDATE prediction_bets SET pick='tie' WHERE discord_id='a'").run();db.prepare('UPDATE prediction_markets SET closes_at=? WHERE id=?').run(121000,m.id);
 await s.handleAdminCommand(message,['settle','DH96AX','tie','Verified completed tie and frozen bets']);const p=messages.at(-1);assert.match(p.content,/<t:121:F>/);await confirm(p);
 assert.equal(s.store.account('a').balance,1270);assert.equal(s.store.latest('DH96AX').result,'tie');assert.equal(s.store.latest('DH96AX').closes_at,121000);assert.equal(s.store.houseFunding(),0);assert.equal(s.store.assertAccounting(),true);
});
