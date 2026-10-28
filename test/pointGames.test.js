"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {PredictionStore}=require("../predictions/store");
const {PointGames}=require("../predictions/games");
function setup(t,number=()=>0){const db=new Database(":memory:");t.after(()=>db.close());const store=new PredictionStore(db);return {store,games:new PointGames(store,{randomInt:number})};}
const ctx=(id,now=1000,actorId="a")=>({operationKey:id,actorId,now});
test("roulette pays standard single-zero bets and allows immediate repeat spins",t=>{
 const {store,games}=setup(t,()=>1);
 const first=games.roulette({guildId:"g",userId:"a",pick:"red",stake:100,context:ctx("one")});
 assert.equal(first.number,1);assert.equal(first.returned,200);assert.equal(store.account("a").balance,1100);
 assert.deepEqual(games.roulette({guildId:"g",userId:"a",pick:"red",stake:100,context:ctx("one")}),first);
 assert.equal(games.roulette({guildId:"g",userId:"a",pick:"black",stake:10,context:ctx("two",1000)}).returned,0);
 games.roulette({guildId:"g",userId:"b",pick:"1",stake:10,context:ctx("three",1001,"b")});
 assert.equal(store.account("b").balance,1350);
 assert.equal(games.roulette({guildId:"g",userId:"a",pick:"1",stake:1,context:ctx("four",121000)}).returned,36);
 assert.equal(store.assertAccounting(),true);
});
test("coin flip loss and invalid stakes do not corrupt accounts",t=>{
 const {store,games}=setup(t,()=>1);
 assert.throws(()=>games.coinflip({userId:"a",pick:"heads",stake:101,context:ctx("bad")}),/stake/i);
 const result=games.coinflip({userId:"a",pick:"heads",stake:50,context:ctx("flip")});
 assert.equal(result.returned,0);assert.equal(store.account("a").balance,950);assert.equal(store.assertAccounting(),true);
});
test("duel requires targeted acceptance, checks both balances and pays only once",t=>{
 const {store,games}=setup(t,()=>0);
 games.challenge({guildId:"g",userId:"a",opponentId:"b",stake:100,context:ctx("challenge")});
 assert.throws(()=>games.accept({guildId:"g",userId:"c",challengeId:"challenge",context:ctx("wrong",1001,"c")}),/opponent/i);
 const result=games.accept({guildId:"g",userId:"b",challengeId:"challenge",context:ctx("accept",1002,"b")});
 assert.equal(result.winner,"a");assert.equal(store.account("a").balance,1100);assert.equal(store.account("b").balance,900);
 assert.deepEqual(games.accept({guildId:"g",userId:"b",challengeId:"challenge",context:ctx("accept",1002,"b")}),result);
 assert.throws(()=>games.accept({guildId:"g",userId:"b",challengeId:"challenge",context:ctx("again",1003,"b")}),/pending/i);
 assert.equal(store.assertAccounting(),true);
});

test("Discord games accept commands and display roulette result without exposing bank balance",async t=>{
 const {store,games}=setup(t,()=>0),{register}=require('../predictions/gameCommands');
 const registry=new Map(),messages=[];register(registry,games,{clock:()=>1000});
 const msg={id:'1',guild:{id:'g'},author:{id:'a'},channel:{send:async p=>messages.push(p)}};
 await registry.get('roulette')(msg,['red','10']);
 assert.match(messages[0].content,/green/i);assert.match(messages[0].content,/0 points returned/i);
 assert.doesNotMatch(messages[0].content,/balance/i);assert.equal(store.account('a').balance,990);
});
test("expired duels do not transfer points",t=>{
 const {store,games}=setup(t);games.challenge({guildId:'g',userId:'a',opponentId:'b',stake:10,context:ctx('d')});
 assert.throws(()=>games.accept({guildId:'g',userId:'b',challengeId:'d',context:ctx('late',121000,'b')}),/pending/i);
 assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
});

test('financial pause blocks new point games',t=>{
 const {store,games}=setup(t);store.setMetadata('paused','1');
 assert.throws(()=>games.coinflip({userId:'a',pick:'heads',stake:10,context:ctx('pause')}),/paused/i);
 assert.equal(store.account('a'),undefined);
});

test('roulette remains available after restarting the service',t=>{
 const {store,games}=setup(t,()=>0);
 games.roulette({guildId:'g',userId:'a',pick:'red',stake:1,context:ctx('first')});
 const restarted=new PointGames(store,{randomInt:()=>0});
 assert.equal(restarted.roulette({guildId:'g',userId:'a',pick:'red',stake:1,context:ctx('second',1001)}).returned,0);
 assert.equal(restarted.roulette({guildId:'other',userId:'a',pick:'0',stake:1,context:ctx('third',1001)}).returned,36);
 assert.equal(store.assertAccounting(),true);
});
test('a failed roulette wager does not block another player',t=>{
 const {store,games}=setup(t,()=>1);
 store.adjust('a',-1000,{...ctx('empty'),reason:'test'});
 assert.throws(()=>games.roulette({guildId:'g',userId:'a',pick:'red',stake:1,context:ctx('fail')}),/funds/i);
 assert.equal(games.roulette({guildId:'g',userId:'b',pick:'red',stake:1,context:ctx('works',1000,'b')}).returned,2);
 assert.equal(store.assertAccounting(),true);
});


test('point gifts transfer available funds exactly once and preserve accounting',t=>{
 const {store,games}=setup(t);store.ensureAccount('b',ctx('setup'));
 const input={userId:'a',recipientId:'b',points:300,context:ctx('gift')};
 const result=games.give(input);assert.equal(result.points,300);
 assert.deepEqual(games.give(input),result);
 assert.equal(store.account('a').balance,700);assert.equal(store.account('b').balance,1300);
 assert.equal(store.assertAccounting(),true);
});
test('point gifts reject invalid amounts, self transfers, and insufficient funds without changes',t=>{
 const {store,games}=setup(t);store.ensureAccount('a',ctx('setup'));
 for(const points of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,1001])assert.throws(()=>games.give({userId:'a',recipientId:'b',points,context:ctx(`gift:${points}`)}));
 assert.throws(()=>games.give({userId:'a',recipientId:'a',points:1,context:ctx('self')}),/another player/i);
 assert.equal(store.account('a').balance,1000);assert.equal(store.account('b'),undefined);assert.equal(store.assertAccounting(),true);
});
test('give command sends points to a mentioned player',async t=>{
 const {store,games}=setup(t),{register}=require('../predictions/gameCommands');const registry=new Map(),messages=[];
 register(registry,games,{clock:()=>1000});
 const msg={id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{send:async p=>messages.push(p)}};
 await registry.get('give')(msg,['<@2>','50']);assert.equal(store.account('1').balance,950);assert.equal(store.account('2').balance,1050);
 assert.match(messages[0].content,/50 points/i);assert.doesNotMatch(messages[0].content,/balance/i);
});

test('duel challenge presents an accept button and only the intended player can use it',async t=>{
 const {store,games}=setup(t,()=>0),{register}=require('../predictions/gameCommands');
 const registry=new Map(),messages=[];const handleInteraction=register(registry,games,{clock:()=>1000});
 const msg={id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{send:async p=>messages.push(p)}};
 await registry.get('duel')(msg,['<@2>','10']);
 const button=messages[0].components[0].components[0];assert.equal(button.label,'Accept Duel');
 let reply,update;
 const interaction={id:'200',customId:button.custom_id,guildId:'g',user:{id:'3'},isButton:()=>true,reply:async p=>{reply=p},update:async p=>{update=p}};
 await handleInteraction(interaction);assert.match(reply.content,/opponent/i);assert.equal(reply.ephemeral,true);assert.equal(store.account('1').balance,1000);
 interaction.id='201';interaction.user.id='2';reply=undefined;
 await handleInteraction(interaction);assert.match(update.content,/won 10 points/i);assert.deepEqual(update.components,[]);
 assert.equal(store.account('1').balance,1010);assert.equal(store.account('2').balance,990);assert.equal(store.assertAccounting(),true);
});
test('expired duel button cannot settle a challenge',async t=>{
 const {store,games}=setup(t),{register}=require('../predictions/gameCommands');let now=1000,reply;
 const registry=new Map(),messages=[];const handleInteraction=register(registry,games,{clock:()=>now});
 await registry.get('duel')({id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{send:async p=>messages.push(p)}},['<@2>','10']);
 now=121000;await handleInteraction({id:'202',customId:messages[0].components[0].components[0].custom_id,guildId:'g',user:{id:'2'},isButton:()=>true,reply:async p=>{reply=p}});
 assert.match(reply.content,/no longer pending/i);assert.equal(store.account('1').balance,1000);assert.equal(store.assertAccounting(),true);
});
