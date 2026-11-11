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
 const registry=new Map(),messages=[];register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 const msg={id:'1',guild:{id:'g'},author:{id:'a'},channel:{id:'casino',send:async p=>messages.push(p)}};
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
 register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 const msg={id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{id:'casino',send:async p=>messages.push(p)}};
 await registry.get('give')(msg,['<@2>','50']);assert.equal(store.account('1').balance,950);assert.equal(store.account('2').balance,1050);
 assert.match(messages[0].content,/50 points/i);assert.doesNotMatch(messages[0].content,/balance/i);
});

test('duel challenge presents an accept button and only the intended player can use it',async t=>{
 const {store,games}=setup(t,()=>0),{register}=require('../predictions/gameCommands');
 const registry=new Map(),messages=[];const handleInteraction=register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 const msg={id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{id:'casino',send:async p=>messages.push(p)}};
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
 const registry=new Map(),messages=[];const handleInteraction=register(registry,games,{clock:()=>now,casinoChannelId:'casino'});
 await registry.get('duel')({id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{id:'casino',send:async p=>messages.push(p)}},['<@2>','10']);
 now=121000;await handleInteraction({id:'202',customId:messages[0].components[0].components[0].custom_id,guildId:'g',user:{id:'2'},isButton:()=>true,reply:async p=>{reply=p}});
 assert.match(reply.content,/no longer pending/i);assert.equal(store.account('1').balance,1000);assert.equal(store.assertAccounting(),true);
});

test('only challenged player can decline a duel without changing points',async t=>{
 const {store,games}=setup(t),{register}=require('../predictions/gameCommands');const registry=new Map(),messages=[];
 const handle=register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 await registry.get('duel')({id:'123',guild:{id:'g'},author:{id:'1'},mentions:{users:{first:()=>({id:'2',bot:false})}},channel:{id:'casino',send:async p=>messages.push(p)}},['<@2>','10']);
 const button=messages[0].components[0].components.find(b=>b.label==='Decline Duel');assert.ok(button);
 let reply,update;const i={id:'201',customId:button.custom_id,guildId:'g',user:{id:'3'},isButton:()=>true,reply:async p=>{reply=p},update:async p=>{update=p}};
 await handle(i);assert.match(reply.content,/opponent/i);assert.equal(reply.ephemeral,true);
 i.id='202';i.user.id='2';await handle(i);assert.match(update.content,/declined/i);assert.deepEqual(update.components,[]);
 assert.equal(store.account('1').balance,1000);assert.equal(store.account('2'),undefined);
 assert.throws(()=>games.accept({guildId:'g',userId:'2',challengeId:'game:123',context:ctx('later',1001,'2')}),/no longer pending/i);
 assert.equal(store.assertAccounting(),true);
});

function baccaratDraws(ranks){
 const shoe=Array.from({length:416},(_,i)=>Math.floor(i/32)+1);let pos=0;
 return max=>{assert.equal(max,shoe.length);const index=shoe.indexOf(ranks[pos++]);assert.notEqual(index,-1);shoe.splice(index,1);return index;};
}
test('baccarat settles player, banker and tie bets and preserves accounting on replay',t=>{
 for(const [pick,ranks,stake,expected,outcome] of [
  ['player',[4,2,4,3],100,200,'player'],['banker',[3,4,3,5],99,193,'banker'],
  ['tie',[4,4,4,4],10,90,'tie'],['player',[4,4,4,4],10,10,'tie'],['tie',[4,2,4,3],10,0,'player']]){
  const {games,store}=setup(t,baccaratDraws(ranks));const input={userId:pick,pick,stake,context:ctx(`b:${pick}:${stake}`)};
  const result=games.baccarat(input);assert.equal(result.outcome,outcome);assert.equal(result.returned,expected);assert.deepEqual(games.baccarat(input),result);assert.equal(store.account(pick).balance,1000-stake+expected);assert.equal(store.assertAccounting(),true);
 }
});
test('baccarat draws the player and banker third cards according to the tableau',t=>{
 const {games}=setup(t,baccaratDraws([2,2,3,1,8,4]));
 const r=games.baccarat({userId:'a',pick:'player',stake:10,context:ctx('draw')});
 assert.equal(r.player.length,3);assert.equal(r.banker.length,2);assert.equal(r.playerTotal,3);assert.equal(r.bankerTotal,3);assert.equal(r.outcome,'tie');
 const next=setup(t,baccaratDraws([2,2,3,1,7,4])).games.baccarat({userId:'a',pick:'banker',stake:10,context:ctx('draw2')});
 assert.equal(next.banker.length,3);assert.equal(next.bankerTotal,7);
});
test('baccarat command displays hands and outcome, and respects pause',async t=>{
 const {games,store}=setup(t,baccaratDraws([4,2,4,3])),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 const msg={id:'b1',guild:{id:'g'},author:{id:'a'},channel:{id:'casino',send:async p=>messages.push(p)}};
 await registry.get('baccarat')(msg,['player','100']);assert.match(messages[0].content,/player.*8/i);assert.match(messages[0].content,/banker.*5/i);assert.match(messages[0].content,/200 points returned/i);assert.doesNotMatch(messages[0].content,/balance/i);
 store.setMetadata('paused','1');msg.id='b2';await registry.get('baccarat')(msg,['player','10']);assert.match(messages[1].content,/paused/i);assert.equal(store.assertAccounting(),true);
});

test('baccarat banker third-card decisions follow the complete tableau',t=>{
 for(let banker=0;banker<=7;banker++)for(let third=0;third<=9;third++){
  const draws=banker<=2||(banker===3&&third!==8)||(banker===4&&third>=2&&third<=7)||(banker===5&&third>=4&&third<=7)||(banker===6&&(third===6||third===7));
  const {games}=setup(t,baccaratDraws([2,banker||10,3,10,third||10,1]));
  const result=games.baccarat({userId:'a',pick:'player',stake:1,context:ctx(`tableau:${banker}:${third}`)});
  assert.equal(result.banker.length,draws?3:2,`banker ${banker}, player third ${third}`);
 }
});
test('baccarat rejects invalid bets and insufficient funds without ledger changes',t=>{
 const {games,store}=setup(t,baccaratDraws([4,2,4,3]));
 assert.throws(()=>games.baccarat({userId:'a',pick:'invalid',stake:10,context:ctx('bad')}),/choose/i);
 assert.throws(()=>games.baccarat({userId:'a',pick:'player',stake:101,context:ctx('limit')}),/stake/i);
 store.adjust('a',-1000,{...ctx('empty'),reason:'test'});
 assert.throws(()=>games.baccarat({userId:'a',pick:'player',stake:10,context:ctx('funds')}),/funds/i);
 assert.equal(store.account('a').balance,0);assert.equal(store.assertAccounting(),true);
});
test('casino commands are ignored outside the configured channel and when configuration is missing',async t=>{
 const {store,games}=setup(t),{register}=require('../predictions/gameCommands');
 const outputs=[],registry=new Map();register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});
 const msg={id:'801',guild:{id:'g'},author:{id:'1'},channel:{id:'elsewhere',send:async p=>outputs.push(p)},mentions:{users:{first:()=>({id:'2',bot:false})}}};
 for(const [name,args] of [['baccarat',['player','10']],['roulette',['red','10']],['coinflip',['heads','10']],['duel',['<@2>','10']],['duel',['accept','123']]])await registry.get(name)(msg,args);
 assert.equal(outputs.length,0);assert.equal(store.account('1'),undefined);
 msg.channel.id='casino';await registry.get('roulette')(msg,['red','10']);assert.equal(outputs.length,1);assert.equal(store.account('1').balance,990);
 const unconfigured=new Map();register(unconfigured,games,{clock:()=>1000});msg.id='802';await unconfigured.get('coinflip')(msg,['heads','10']);assert.equal(outputs.length,1);assert.equal(store.account('1').balance,990);
});
test('give remains available outside the casino channel',async t=>{
 const {store,games}=setup(t),{register}=require('../predictions/gameCommands');const registry=new Map(),outputs=[];
 register(registry,games,{casinoChannelId:'casino',clock:()=>1000});
 const msg={id:'803',guild:{id:'g'},author:{id:'1'},channel:{id:'elsewhere',send:async p=>outputs.push(p)},mentions:{users:{first:()=>({id:'2',bot:false})}}};
 await registry.get('give')(msg,['<@2>','10']);assert.equal(outputs.length,1);assert.equal(store.account('1').balance,990);assert.equal(store.account('2').balance,1010);
});

test('each casino game works in the configured channel',async t=>{
 const {store,games}=setup(t,()=>0),{register}=require('../predictions/gameCommands');const registry=new Map(),outputs=[];
 register(registry,games,{casinoChannelId:'casino',clock:()=>1000});
 const msg={id:'901',guild:{id:'g'},author:{id:'1'},channel:{id:'casino',send:async p=>outputs.push(p)},mentions:{users:{first:()=>({id:'2',bot:false})}}};
 await registry.get('roulette')(msg,['0','10']);msg.id='902';await registry.get('coinflip')(msg,['heads','10']);msg.id='903';await registry.get('duel')(msg,['<@2>','10']);
 assert.equal(outputs.length,3);assert.match(outputs[0].content,/wheel/i);assert.match(outputs[1].content,/heads/i);assert.equal(outputs[2].components[0].components.length,2);
 assert.equal(store.assertAccounting(),true);
});
