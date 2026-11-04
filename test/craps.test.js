'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store'),{PointGames}=require('../predictions/games');
const ctx=(id,user='a',now=1000)=>({operationKey:id,actorId:user,now});
function setup(t,dice){const db=new Database(':memory:');t.after(()=>db.close());const store=new PredictionStore(db);let n=0;const games=new PointGames(store,{randomInt:()=>dice[n++]-1});return {db,store,games};}
test('shared craps holds bets, survives restart and settles a point once',t=>{
 const {games,store}=setup(t,[2,2,3,3,2,2]);
 const round=games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'pass',stake:20,context:ctx('join')});
 games.crapsJoin({guildId:'g',channelId:'c',userId:'b',pick:'dont',stake:30,context:ctx('join2','b')});
 assert.equal(store.account('a').balance,980);assert.equal(store.assertAccounting(),true);
 const roll=()=>games.crapsRoll({roundId:round.id,guildId:'g',channelId:'c',userId:'a',context:ctx('roll')});
 assert.equal(roll().point,4);assert.deepEqual(roll(),roll());
 assert.throws(()=>games.crapsJoin({guildId:'g',channelId:'c',userId:'c',pick:'pass',stake:1,context:ctx('late','c')}),/betting/i);
 const restarted=new PointGames(store,{randomInt:()=>1});
 assert.equal(restarted.crapsStatus({guildId:'g',channelId:'c'}).point,4);
 const middle=games.crapsRoll({roundId:round.id,guildId:'g',channelId:'c',userId:'a',context:ctx('middle')});assert.equal(middle.state,'point');
 const final=games.crapsRoll({roundId:round.id,guildId:'g',channelId:'c',userId:'a',context:ctx('finish')});assert.equal(final.outcome,'pass');assert.equal(store.account('a').balance,1020);assert.equal(store.account('b').balance,970);assert.equal(store.assertAccounting(),true);
});
test('come out outcomes and pushes settle properly',t=>{
 for(const [dice,outcome,pass,dont] of [[[3,4],'pass',1100,900],[[1,1],'dont',900,1100],[[6,6],'push',900,1000]]){
  const {games,store}=setup(t,dice);const a=games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'pass',stake:100,context:ctx('a')});games.crapsJoin({guildId:'g',channelId:'c',userId:'b',pick:'dont',stake:100,context:ctx('b','b')});
  const r=games.crapsRoll({roundId:a.id,guildId:'g',channelId:'c',userId:'a',context:ctx('r')});assert.equal(r.outcome,outcome);assert.equal(store.account('a').balance,pass);assert.equal(store.account('b').balance,dont);assert.equal(store.assertAccounting(),true);
 }
});
test('craps enforces shooter, cancellation, pause, idle takeover and guild isolation',t=>{
 const {games,store}=setup(t,[2,2,3,4]);const r=games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'pass',stake:10,context:ctx('join')});
 games.crapsJoin({guildId:'g',channelId:'c',userId:'b',pick:'dont',stake:10,context:ctx('join-b','b')});
 assert.throws(()=>games.crapsRoll({roundId:r.id,guildId:'g',channelId:'c',userId:'b',context:ctx('wrong','b')}),/shooter/i);
 assert.throws(()=>games.crapsRoll({roundId:r.id,guildId:'other',channelId:'c',userId:'a',context:ctx('wrong-g')}),/table/i);
 store.setMetadata('paused','1');assert.throws(()=>games.crapsJoin({guildId:'g',channelId:'c',userId:'c',pick:'pass',stake:1,context:ctx('paused','c')}),/paused/i);
 games.crapsRoll({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('first')});
 assert.throws(()=>games.crapsCancel({guildId:'g',channelId:'c',userId:'a',context:ctx('cancel')}),/first roll/i);
 const final=games.crapsRoll({roundId:r.id,guildId:'g',channelId:'c',userId:'b',context:ctx('takeover','b',601001)});assert.equal(final.outcome,'dont');assert.equal(store.assertAccounting(),true);
});
test('shooter can cancel before the first roll and refund all wagers',t=>{
 const {games,store}=setup(t,[]);games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'pass',stake:10,context:ctx('join')});games.crapsJoin({guildId:'g',channelId:'c',userId:'b',pick:'dont',stake:20,context:ctx('join2','b')});
 assert.throws(()=>games.crapsCancel({guildId:'g',channelId:'c',userId:'b',context:ctx('no','b')}),/shooter/i);
 games.crapsCancel({guildId:'g',channelId:'c',userId:'a',context:ctx('cancel')});assert.equal(store.account('a').balance,1000);assert.equal(store.account('b').balance,1000);assert.equal(store.assertAccounting(),true);
});

test('Discord craps buttons enforce casino channel and shooter while completing a shared round',async t=>{
 const {games,store}=setup(t,[2,2,3,4]),registry=new Map(),messages=[];
 const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const message={id:'101',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};
 await registry.get('craps')(message,['join','pass','10']);message.id='102';message.author.id='b';await registry.get('craps')(message,['join','dont','10']);
 const button=messages[0].components[0].components[0];let output;
 const i={id:'103',customId:button.custom_id,guildId:'g',channelId:'c',user:{id:'b'},isButton:()=>true,reply:async p=>{output=p},update:async p=>{output=p}};
 await handle(i);assert.match(output.content,/shooter/i);assert.equal(output.ephemeral,true);
 i.id='104';i.channelId='other';i.user.id='a';await handle(i);assert.equal(output.ephemeral,true);assert.match(output.content,/unavailable/i);
 i.id='105';i.channelId='c';await handle(i);assert.match(output.content,/point.*4/i);assert.ok(output.components.length);
 i.id='106';await handle(i);assert.match(output.content,/dont wins/i);assert.equal(output.components.length,0);
 i.id='107';await handle(i);assert.match(output.content,/no longer active/i);assert.equal(store.assertAccounting(),true);
});
test('craps failed settlement rolls back all payouts and keeps the round active',t=>{
 const {games,store,db}=setup(t,[3,4]);const r=games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'pass',stake:10,context:ctx('join')});
 db.exec("CREATE TRIGGER fail_craps BEFORE INSERT ON prediction_transactions WHEN NEW.kind='house_funding' BEGIN SELECT RAISE(ABORT,'test failure'); END");
 assert.throws(()=>games.crapsRoll({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('roll')}),/test failure/);
 assert.equal(store.account('a').balance,990);assert.equal(games.crapsStatus({guildId:'g',channelId:'c'}).state,'open');assert.equal(store.assertAccounting(),true);
});

test('place bets pay profit on every hit, carry across points and lose on seven',t=>{
 const {games,store}=setup(t,[2,3,3,3,2,3,3,4,2,2,3,3,3,4]);
 const round=games.crapsJoin({guildId:'g',channelId:'c',userId:'a',pick:'dont',stake:10,context:ctx('join')});
 const roll=(id,r=round.id)=>games.crapsRoll({roundId:r,guildId:'g',channelId:'c',userId:'a',context:ctx(id)});
 roll('point');const bet={guildId:'g',channelId:'c',userId:'a',number:6,stake:60,context:ctx('place')};games.crapsPlace(bet);assert.deepEqual(games.crapsPlace(bet),games.crapsPlace(bet));assert.equal(store.account('a').balance,930);assert.equal(store.assertAccounting(),true);
 const hit=roll('six');assert.equal(hit.placePayouts[0].profit,70);assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
 const hitPoint=roll('five');assert.equal(hitPoint.outcome,'pass');assert.ok(hitPoint.nextRoundId);assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
 const comeout=roll('comeout-seven',hitPoint.nextRoundId);assert.ok(comeout.nextRoundId);assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
 roll('next-point',comeout.nextRoundId);const hit2=roll('six-again',comeout.nextRoundId);assert.equal(hit2.placePayouts[0].profit,70);
 const seven=roll('seven-out',comeout.nextRoundId);assert.equal(seven.outcome,'dont');assert.equal(store.account('a').balance,1070);assert.equal(store.assertAccounting(),true);
});
test('place bets validate timing, number, stake, duplicates and can be taken down',t=>{
 const {games,store}=setup(t,[2,3]);const base={guildId:'g',channelId:'c',userId:'a'};
 games.crapsJoin({...base,pick:'pass',stake:10,context:ctx('join')});assert.throws(()=>games.crapsPlace({...base,number:6,stake:6,context:ctx('early')}),/point/i);
 const r=games.crapsStatus(base);games.crapsRoll({...base,roundId:r.id,context:ctx('roll')});
 assert.throws(()=>games.crapsPlace({...base,number:7,stake:6,context:ctx('invalid')}),/Choose/i);
 games.crapsPlace({...base,number:6,stake:7,context:ctx('place')});assert.throws(()=>games.crapsPlace({...base,number:6,stake:7,context:ctx('dup')}),/already/i);
 games.crapsPlace({...base,number:8,stake:20,context:ctx('place8')});assert.equal(store.account('a').balance,963);games.crapsTake({...base,number:6,context:ctx('take')});assert.equal(store.account('a').balance,970);assert.equal(store.assertAccounting(),true);
});
test('place bet rates round profit down and preserve held stake',t=>{
 for(const [number,dice,profit] of [[4,[2,2],12],[5,[2,3],9],[6,[3,3],8],[8,[4,4],8],[9,[4,5],9],[10,[4,6],12]]){
  const {games,store}=setup(t,[1,3,...dice]);const base={guildId:'g',channelId:'c',userId:'a'};
  const r=games.crapsJoin({...base,pick:'pass',stake:1,context:ctx('join')});games.crapsRoll({...base,roundId:r.id,context:ctx('first')});
  games.crapsPlace({...base,number,stake:7,context:ctx('place')});const roll=games.crapsRoll({...base,roundId:r.id,context:ctx('hit')});
  assert.equal(roll.placePayouts[0].profit,profit);assert.equal(store.account('a').balance,992+profit+(number===4?2:0));assert.equal(store.assertAccounting(),true);
 }
});
test('place controls work in the casino channel and carry buttons to the next round',async t=>{
 const {games,store}=setup(t,[2,3,2,3]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};
 await registry.get('craps')(m,['join','pass','10']);const button=messages[0].components[0].components[0];let output;
 const i={id:'2',customId:button.custom_id,guildId:'g',channelId:'c',user:{id:'a'},isButton:()=>true,reply:async p=>{output=p},update:async p=>{output=p}};
 await handle(i);m.id='3';await registry.get('craps')(m,['place','5','10']);assert.match(messages.at(-1).content,/placed.*10.*5/i);
 i.id='4';await handle(i);assert.match(output.content,/\+14 points on 5/i);assert.match(output.content,/carry over/i);assert.ok(output.components[0].components[0].custom_id!==button.custom_id);
 m.id='5';await registry.get('craps')(m,['take','5']);assert.match(messages.at(-1).content,/10 points.*back/i);assert.equal(store.assertAccounting(),true);
});
test('existing craps wagers survive schema initialization and a carried place bet is refunded on cancellation',t=>{
 const {games,store,db}=setup(t,[2,3,2,3]);const base={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...base,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...base,roundId:r.id,context:ctx('first')});games.crapsPlace({...base,number:6,stake:25,context:ctx('place')});
 new PredictionStore(db);const done=games.crapsRoll({...base,roundId:r.id,context:ctx('point')});assert.ok(done.nextRoundId);games.crapsCancel({...base,context:ctx('cancel')});
 assert.equal(store.account('a').balance,1010);assert.equal(store.assertAccounting(),true);
});
test('shared craps uses one roll card and updates it rather than posting a new reply',async t=>{
 const {games}=setup(t,[2,2]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'100',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};
 await registry.get('craps')(m,['join','pass','10']);const button=messages[0].components[0].components[0];
 m.id='101';m.author.id='b';await registry.get('craps')(m,['join','dont','10']);assert.equal(messages[1].components?.length||0,0);
 let update,replies=0;await handle({id:'102',customId:button.custom_id,guildId:'g',channelId:'c',user:{id:'a'},isButton:()=>true,reply:async()=>{replies++},update:async p=>{update=p}});
 assert.equal(replies,0);assert.match(update.content,/point.*4/i);assert.equal(update.components.length,1);
});

test('a player can take down only their dont line bet after a point',t=>{
 const {games,store}=setup(t,[2,3,3,4]);const base={guildId:'g',channelId:'c'};
 const round=games.crapsJoin({...base,userId:'a',pick:'dont',stake:20,context:ctx('join-a')});
 games.crapsJoin({...base,userId:'b',pick:'pass',stake:10,context:ctx('join-b','b')});
 games.crapsRoll({...base,userId:'a',roundId:round.id,context:ctx('point')});
 assert.throws(()=>games.crapsTakeLine({...base,userId:'b',context:ctx('pass','b')}),/pass/i);
 games.crapsTakeLine({...base,userId:'a',context:ctx('take')});
 assert.equal(store.account('a').balance,1000);assert.equal(store.account('b').balance,990);
 games.crapsRoll({...base,userId:'a',roundId:round.id,context:ctx('seven')});
 assert.equal(store.account('a').balance,1000);assert.equal(store.account('b').balance,990);assert.equal(store.assertAccounting(),true);
});

test('Discord players can take down their own dont line wager',async t=>{
 const {games,store}=setup(t,[2,3]),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};
 await registry.get('craps')(m,['join','dont','20']);const round=games.crapsStatus({guildId:'g',channelId:'c'});
 games.crapsRoll({guildId:'g',channelId:'c',userId:'a',roundId:round.id,context:ctx('point')});
 m.id='2';await registry.get('craps')(m,['take','dont']);assert.match(messages.at(-1).content,/20 points back/i);assert.equal(store.account('a').balance,1000);
});

test('field and proposition bets settle once with correct payouts',t=>{
 const {games,store}=setup(t,[2,3,1,1]);const base={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...base,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...base,roundId:r.id,context:ctx('point')});
 games.crapsWager({...base,kind:'field',stake:10,context:ctx('field')});games.crapsWager({...base,kind:'prop',number:2,stake:2,context:ctx('prop')});
 games.crapsRoll({...base,roundId:r.id,context:ctx('roll')});assert.equal(store.account('a').balance,1070);assert.equal(store.assertAccounting(),true);
});
test('come and dont come move to their own points and settle independently',t=>{
 const {games,store}=setup(t,[2,3,3,3,1,5]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'come',stake:10,context:ctx('come')});games.crapsWager({...b,kind:'dontcome',stake:10,context:ctx('dontcome')});
 games.crapsRoll({...b,roundId:r.id,context:ctx('set')});games.crapsRoll({...b,roundId:r.id,context:ctx('hit')});
 assert.equal(store.account('a').balance,990);assert.equal(store.assertAccounting(),true);
});

test('hardway pays on doubles, remains up, and loses to an easy roll',t=>{
 const {games,store}=setup(t,[2,3,3,3,2,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'hardway',number:6,stake:10,context:ctx('hard')});games.crapsRoll({...b,roundId:r.id,context:ctx('hardhit')});assert.equal(store.account('a').balance,1070);
 games.crapsRoll({...b,roundId:r.id,context:ctx('easy')});assert.equal(store.account('a').balance,1070);assert.equal(store.assertAccounting(),true);
});
test('lay wager can be turned off and then wins with commission on seven',t=>{
 const {games,store}=setup(t,[2,3,3,4,3,3,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'lay',number:4,stake:20,context:ctx('lay')});games.crapsWorking({...b,kind:'lay',number:4,working:'off',context:ctx('off')});
 const seven=games.crapsRoll({...b,roundId:r.id,context:ctx('seven')});assert.equal(store.account('a').balance,970);
 games.crapsWorking({...b,kind:'lay',number:4,working:'on',context:ctx('on')});games.crapsRoll({...b,roundId:seven.nextRoundId,context:ctx('six')});
 games.crapsRoll({...b,roundId:seven.nextRoundId,context:ctx('win')});assert.equal(store.account('a').balance,999);assert.equal(store.assertAccounting(),true);
});

test('pass line odds pay true odds with the line and conserve accounting',t=>{
 const {games,store}=setup(t,[2,2,2,2]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsOdds({...b,target:'pass',stake:10,context:ctx('odds')});games.crapsRoll({...b,roundId:r.id,context:ctx('win')});
 assert.equal(store.account('a').balance,1030);assert.equal(store.assertAccounting(),true);
});
test('come odds travel with their come bet and are off on a come-out roll',t=>{
 const {games,store}=setup(t,[2,3,3,3,2,3,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'come',stake:10,context:ctx('come')});games.crapsRoll({...b,roundId:r.id,context:ctx('six')});
 games.crapsOdds({...b,target:'come',number:6,stake:10,context:ctx('odds')});const p=games.crapsRoll({...b,roundId:r.id,context:ctx('pointwin')});
 games.crapsRoll({...b,roundId:p.nextRoundId,context:ctx('comeout')});assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
});

test('taking down dont pass also refunds its odds once',t=>{
 const {games,store}=setup(t,[2,2,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'dont',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsOdds({...b,target:'dont',stake:20,context:ctx('odds')});games.crapsTakeLine({...b,context:ctx('take')});assert.equal(store.account('a').balance,1000);
 games.crapsRoll({...b,roundId:r.id,context:ctx('seven')});assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
});
test('place bet can be switched off across rolls and restored on',t=>{
 const {games,store}=setup(t,[2,3,3,3,3,3]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsPlace({...b,number:6,stake:6,context:ctx('place')});
 games.crapsWorking({...b,kind:'place',number:6,working:'off',context:ctx('off')});games.crapsRoll({...b,roundId:r.id,context:ctx('offroll')});assert.equal(store.account('a').balance,984);
 games.crapsWorking({...b,kind:'place',number:6,working:'on',context:ctx('on')});games.crapsRoll({...b,roundId:r.id,context:ctx('onroll')});assert.equal(store.account('a').balance,991);assert.equal(store.assertAccounting(),true);
});

test('taking down a dont come wager refunds its attached odds only to its owner',t=>{
 const {games,store}=setup(t,[2,3,3,3,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'dontcome',stake:10,context:ctx('dontcome')});games.crapsRoll({...b,roundId:r.id,context:ctx('six')});games.crapsOdds({...b,target:'dontcome',number:6,stake:20,context:ctx('odds')});
 assert.throws(()=>games.crapsTakeWager({...b,userId:'b',kind:'dontcome',number:6,context:ctx('steal','b')}),/not found/i);
 games.crapsTakeWager({...b,kind:'dontcome',number:6,context:ctx('take')});assert.equal(store.account('a').balance,990);
 games.crapsRoll({...b,roundId:r.id,context:ctx('seven')});assert.equal(store.account('a').balance,990);assert.equal(store.assertAccounting(),true);
});

test('Discord commands accept new bets, odds and working controls for several players',async t=>{
 const {games,store}=setup(t,[2,3,3,3]),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};
 await registry.get('craps')(m,['join','pass','10']);const r=games.crapsStatus({guildId:'g',channelId:'c'});games.crapsRoll({guildId:'g',channelId:'c',userId:'a',roundId:r.id,context:ctx('roll')});
 m.author.id='b';m.id='2';await registry.get('craps')(m,['come','10']);assert.match(messages.at(-1).content,/come/i);
 m.id='3';await registry.get('craps')(m,['hardway','33','10']);assert.match(messages.at(-1).content,/hardway/i);
 m.id='4';await registry.get('craps')(m,['off','hardway','6']);assert.match(messages.at(-1).content,/off/i);
 m.id='5';await registry.get('craps')(m,['field','10']);assert.match(messages.at(-1).content,/field/i);assert.equal(store.assertAccounting(),true);
});

test('come odds may be turned on for a come-out seven',t=>{
 const {games,store}=setup(t,[2,3,3,3,2,3,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsWager({...b,kind:'come',stake:10,context:ctx('come')});games.crapsRoll({...b,roundId:r.id,context:ctx('six')});
 games.crapsOdds({...b,target:'come',number:6,stake:10,context:ctx('odds')});games.crapsWorking({...b,kind:'odds_come',number:6,working:'on',context:ctx('on')});
 const p=games.crapsRoll({...b,roundId:r.id,context:ctx('pointwin')});games.crapsRoll({...b,roundId:p.nextRoundId,context:ctx('seven')});assert.equal(store.account('a').balance,990);assert.equal(store.assertAccounting(),true);
});

test('each Discord roll publishes a separate permanent roll result',async t=>{
 const {games}=setup(t,[2,2,3,4]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['join','pass','10']);
 const id=messages[0].components[0].components[0].custom_id,history=[];
 const i={id:'2',customId:id,guildId:'g',channelId:'c',user:{id:'a'},isButton:()=>true,update:async()=>{},followUp:async p=>history.push(p)};
 await handle(i);i.id='3';await handle(i);assert.equal(history.length,2);assert.match(history[0].content,/4/);assert.match(history[1].content,/7/);
});

test('dont come pushes 12 on its first roll and dont odds pay true odds on seven',t=>{
 const {games,store}=setup(t,[2,2,6,6,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'dont',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsOdds({...b,target:'dont',stake:20,context:ctx('odds')});
 games.crapsWager({...b,kind:'dontcome',stake:10,context:ctx('dc')});games.crapsRoll({...b,roundId:r.id,context:ctx('twelve')});assert.equal(store.account('a').balance,970);
 games.crapsRoll({...b,roundId:r.id,context:ctx('seven')});assert.equal(store.account('a').balance,1020);assert.equal(store.assertAccounting(),true);
});
test('a place wager called on is lost on a come-out seven',t=>{
 const {games,store}=setup(t,[2,3,2,3,3,4]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsPlace({...b,number:6,stake:6,context:ctx('place')});
 games.crapsWorking({...b,kind:'place',number:6,working:'on',context:ctx('on')});const p=games.crapsRoll({...b,roundId:r.id,context:ctx('hit')});games.crapsRoll({...b,roundId:p.nextRoundId,context:ctx('seven')});
 assert.equal(store.account('a').balance,1004);assert.equal(store.assertAccounting(),true);
});
test('schema migration keeps an existing active place wager and gives it automatic mode',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE point_craps_places(round_id INTEGER NOT NULL,user_id TEXT NOT NULL,number INTEGER NOT NULL,stake INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(round_id,user_id,number)); INSERT INTO point_craps_places VALUES(7,'a',6,20,'active')");
 new PredictionStore(db);assert.deepEqual(db.prepare('SELECT stake,status,working FROM point_craps_places').get(),{stake:20,status:'active',working:'auto'});
});

test('a removed dont pass wager may be replaced before the first roll',t=>{
 const {games,store}=setup(t,[2,2]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'dont',stake:10,context:ctx('join')});games.crapsTakeLine({...b,context:ctx('take')});
 games.crapsJoin({...b,pick:'dont',stake:20,context:ctx('rejoin')});games.crapsRoll({...b,roundId:r.id,context:ctx('roll')});
 assert.equal(store.account('a').balance,980);assert.equal(store.assertAccounting(),true);
});

test('table status pages show bets beyond the first ten',async t=>{
 const {games}=setup(t,[2,3]),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 for(let n=0;n<11;n++)games.crapsWager({...b,userId:String(n),kind:'field',stake:1,context:ctx('field'+n,String(n))});
 const m={id:'status',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['status','2']);assert.match(messages[0].content,/page 2/i);assert.match(messages[0].content,/<@9>/);
});

test('bank statement includes all new craps wager stakes in held funds',async t=>{
 const {games,store}=setup(t,[2,3]),b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
 games.crapsWager({...b,kind:'field',stake:15,context:ctx('field')});games.crapsOdds({...b,target:'pass',stake:20,context:ctx('odds')});
 let output;const service={store,context:()=>ctx('bank'),clock:()=>1000,logger:{warn(){}},config:{channels:{}}};
 await require('../predictions/bank').handleBankCommand(service,{author:{id:'a',send:async p=>{output=p}},client:null});assert.match(output.content,/Held in active bets: \*\*45 points\*\*/);assert.match(output.content,/Total points: \*\*1,000\*\*/);
});

test('new wagers persist after restart and settlement failure rolls back every payout',t=>{
 const {games,store,db}=setup(t,[2,3,1,1]);const b={guildId:'g',channelId:'c',userId:'a'};
 const r=games.crapsJoin({...b,pick:'pass',stake:10,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsWager({...b,kind:'field',stake:10,context:ctx('field')});
 const restarted=new PointGames(new PredictionStore(db),{randomInt:()=>0});db.exec("CREATE TRIGGER fail_extra BEFORE INSERT ON prediction_transactions WHEN NEW.kind='house_funding' BEGIN SELECT RAISE(ABORT,'test failure'); END");
 assert.throws(()=>restarted.crapsRoll({...b,roundId:r.id,context:ctx('fail')}),/test failure/);assert.equal(store.account('a').balance,980);assert.equal(store.assertAccounting(),true);
 db.exec('DROP TRIGGER fail_extra');restarted.crapsRoll({...b,roundId:r.id,context:ctx('retry')});assert.equal(store.account('a').balance,1010);assert.equal(store.assertAccounting(),true);
});

test('lay bets pay the three true-odds rates less commission',t=>{
 for(const [number,profit] of [[4,28],[5,38],[6,47],[8,47],[9,38],[10,28]]){
  const {games,store}=setup(t,[2,3,3,4]),b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});
  games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsWager({...b,kind:'lay',number,stake:60,context:ctx('lay')});games.crapsRoll({...b,roundId:r.id,context:ctx('seven')});
  assert.equal(store.account('a').balance,999+profit,`lay ${number}`);assert.equal(store.assertAccounting(),true);
 }
});
test('individual propositions settle for every supported number',t=>{
 for(const [number,dice,profit] of [[2,[1,1],30],[3,[1,2],15],[11,[5,6],15],[12,[6,6],30]]){
  const {games,store}=setup(t,[2,3,...dice]),b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});
  games.crapsRoll({...b,roundId:r.id,context:ctx('point')});games.crapsWager({...b,kind:'prop',number,stake:1,context:ctx('prop')});games.crapsRoll({...b,roundId:r.id,context:ctx('roll')});
  assert.equal(store.account('a').balance,999+profit,`prop ${number}`);assert.equal(store.assertAccounting(),true);
 }
});

test('pass and dont odds use the correct payout ratios for all six points',t=>{
 for(const [point,dice,passProfit,dontProfit] of [[4,[2,2],120,30],[5,[2,3],90,40],[6,[3,3],72,50],[8,[4,4],72,50],[9,[4,5],90,40],[10,[4,6],120,30]]){
  for(const [pick,winDice,profit] of [['pass',dice,passProfit],['dont',[3,4],dontProfit]]){
   const {games,store}=setup(t,[...dice,...winDice]),b={guildId:'g',channelId:'c',userId:'a'},tag=pick+point;
   const r=games.crapsJoin({...b,pick,stake:1,context:ctx('join'+tag)});games.crapsRoll({...b,roundId:r.id,context:ctx('point'+tag)});
   games.crapsOdds({...b,target:pick,stake:60,context:ctx('odds'+tag)});games.crapsRoll({...b,roundId:r.id,context:ctx('settle'+tag)});
   assert.equal(store.account('a').balance,1001+profit,tag);assert.equal(store.assertAccounting(),true);
  }
 }
});

test('any craps wins on 2, 3 and 12 at 7 to 1 and loses on 11',t=>{
 for(const [dice,profit] of [[[1,1],70],[[1,2],70],[[6,6],70],[[5,6],-10]]){
  const {games,store}=setup(t,[2,3,...dice]),b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
  games.crapsWager({...b,kind:'anycraps',stake:10,context:ctx('bet')});games.crapsRoll({...b,roundId:r.id,context:ctx('result')});assert.equal(store.account('a').balance,999+profit);assert.equal(store.assertAccounting(),true);
 }
});

test('table menu opens a stake popup and places a multiplayer wager for its user',async t=>{
 const {games,store}=setup(t,[2,3]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['join','pass','10']);const round=games.crapsStatus({guildId:'g',channelId:'c'});
 games.crapsRoll({guildId:'g',channelId:'c',userId:'a',roundId:round.id,context:ctx('first')});m.id='table';await registry.get('craps')(m,['table']);
 const panel=messages.at(-1),menu=panel.components.find(r=>r.components[0].type===3).components[0];let modal,reply;
 await handle({id:'choose',customId:menu.custom_id,guildId:'g',channelId:'c',user:{id:'b'},values:['place_6'],isStringSelectMenu:()=>true,isButton:()=>false,isModalSubmit:()=>false,showModal:async x=>{modal=x}});
 assert.ok(modal);const customId=modal.toJSON().custom_id;
 await handle({id:'submit',customId,guildId:'g',channelId:'c',user:{id:'b'},isStringSelectMenu:()=>false,isButton:()=>false,isModalSubmit:()=>true,fields:{getTextInputValue:()=> '12'},reply:async x=>{reply=x}});
 assert.equal(store.account('b').balance,988);assert.match(reply.content,/12/);assert.equal(store.assertAccounting(),true);
});

test('table popup rejects a wager if a roll occurs before submission',async t=>{
 const {games,store}=setup(t,[2,3,2,2]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['join','pass','10']);const round=games.crapsStatus({guildId:'g',channelId:'c'});
 let modal,reply;await handle({id:'choose',customId:'point-craps:choose:1',guildId:'g',channelId:'c',user:{id:'b'},values:['field'],isStringSelectMenu:()=>true,showModal:async x=>{modal=x}});
 games.crapsRoll({guildId:'g',channelId:'c',userId:'a',roundId:round.id,context:ctx('roll')});
 await handle({id:'submit',customId:modal.toJSON().custom_id,guildId:'g',channelId:'c',user:{id:'b'},isModalSubmit:()=>true,fields:{getTextInputValue:()=> '20'},reply:async x=>{reply=x}});
 assert.match(reply.content,/changed/i);assert.equal(store.account('b'),undefined);assert.equal(store.assertAccounting(),true);
});

test('table controls allow an empty table to start and restrict rolling to the shooter',async t=>{
 const {games,store}=setup(t,[2,3]),registry=new Map(),messages=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'table',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['table']);let modal,reply;
 await handle({id:'select',customId:'point-craps:choose:0',guildId:'g',channelId:'c',user:{id:'a'},values:['pass'],isStringSelectMenu:()=>true,showModal:async x=>{modal=x}});
 await handle({id:'submit',customId:modal.toJSON().custom_id,guildId:'g',channelId:'c',user:{id:'a'},isModalSubmit:()=>true,fields:{getTextInputValue:()=> '10'},reply:async x=>{reply=x}});assert.equal(store.account('a').balance,990);
 await handle({id:'wrong',customId:'point-craps:rolltable',guildId:'g',channelId:'c',user:{id:'b'},isButton:()=>true,reply:async x=>{reply=x}});assert.match(reply.content,/Only the shooter/);assert.equal(reply.ephemeral,true);
 await handle({id:'roll',customId:'point-craps:rolltable',guildId:'g',channelId:'c',user:{id:'a'},isButton:()=>true,reply:async x=>{reply=x}});assert.match(reply.content,/point.*5/i);assert.equal(store.assertAccounting(),true);
});
test('table panel rejects wrong channel and invalid menu selections',async t=>{
 const {games,store}=setup(t,[]),registry=new Map();const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});let reply;
 await handle({id:'1',customId:'point-craps:choose:0',guildId:'g',channelId:'elsewhere',user:{id:'a'},isStringSelectMenu:()=>true,values:['pass'],reply:async x=>{reply=x}});assert.match(reply.content,/unavailable/);
 await handle({id:'2',customId:'point-craps:choose:0',guildId:'g',channelId:'c',user:{id:'a'},isStringSelectMenu:()=>true,values:['anycraps'],reply:async x=>{reply=x}});assert.match(reply.content,/valid/);assert.equal(store.account('a'),undefined);
});

test('any craps command accepts and refunds a wager before the roll',async t=>{
 const {games,store}=setup(t,[2,3]),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['join','pass','10']);
 m.id='2';await registry.get('craps')(m,['anycraps','5']);assert.match(messages.at(-1).content,/anycraps/);assert.equal(store.account('a').balance,985);
 m.id='3';await registry.get('craps')(m,['take','anycraps']);assert.equal(store.account('a').balance,990);assert.equal(store.assertAccounting(),true);
});

test('horn splits a stake four ways and pays the correct net return on each number',t=>{
 for(const [dice,returned] of [[[1,1],31],[[1,2],16],[[5,6],16],[[6,6],31],[[3,3],0]]){
  const {games,store}=setup(t,[2,3,...dice]),b={guildId:'g',channelId:'c',userId:'a'};const r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});games.crapsRoll({...b,roundId:r.id,context:ctx('point')});
  games.crapsWager({...b,kind:'horn',stake:4,context:ctx('horn')});games.crapsRoll({...b,roundId:r.id,context:ctx('roll')});assert.equal(store.account('a').balance,995+returned);assert.equal(store.assertAccounting(),true);
 }
});
test('horn bets require stakes in multiples of four',t=>{
 const {games}=setup(t,[]),b={guildId:'g',channelId:'c',userId:'a'};games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});
 assert.throws(()=>games.crapsWager({...b,kind:'horn',stake:5,context:ctx('horn')}),/multiple of 4/i);
});
test('fire bet carries through come-out sevens and four distinct points then pays on seven out',t=>{
 const dice=[2,2,2,2,3,4,2,3,2,3,3,3,3,3,4,4,4,4,4,5,3,4];
 const {games,store}=setup(t,dice),b={guildId:'g',channelId:'c',userId:'a'};let round=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});games.crapsWager({...b,kind:'fire',stake:2,context:ctx('fire')});
 for(let n=0;n<11;n++){const result=games.crapsRoll({...b,roundId:round.id,context:ctx('roll'+n)});if(result.nextRoundId)round={id:result.nextRoundId};}
 assert.equal(store.account('a').balance,1049);assert.equal(store.assertAccounting(),true);
});

test('fire pays 24, 249 or 999 to 1 for four, five or six unique points',t=>{
 const pairs={4:[2,2],5:[2,3],6:[3,3],8:[4,4],9:[4,5],10:[4,6]};
 for(const [count,returned] of [[4,25],[5,250],[6,1000]]){
  const made=[4,5,6,8,9,10].slice(0,count),dice=made.flatMap(n=>[...pairs[n],...pairs[n]]);
  if(count<6)dice.push(...pairs[10],3,4);
  const {games,store}=setup(t,dice),b={guildId:'g',channelId:'c',userId:'a'};let r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join'+count)});games.crapsWager({...b,kind:'fire',stake:1,context:ctx('fire'+count)});
  for(let i=0;i<dice.length/2;i++){const result=games.crapsRoll({...b,roundId:r.id,context:ctx(`roll${count}-${i}`)});if(result.nextRoundId)r={id:result.nextRoundId};}
  assert.equal(store.account('a').balance,1000+returned,`fire ${count}`);assert.equal(store.assertAccounting(),true);
 }
});
test('fire bet is locked after first point, repeated points count once, and loses below four',t=>{
 const {games,store}=setup(t,[2,2,2,2,2,2,2,2,2,3,3,4]),b={guildId:'g',channelId:'c',userId:'a'};let r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});games.crapsWager({...b,kind:'fire',stake:10,context:ctx('fire')});
 const roll=id=>{const result=games.crapsRoll({...b,roundId:r.id,context:ctx(id)});if(result.nextRoundId)r={id:result.nextRoundId};return result;};
 roll('set');assert.throws(()=>games.crapsWager({...b,userId:'b',kind:'fire',stake:10,context:ctx('late','b')}),/before.*first point/i);assert.throws(()=>games.crapsTakeWager({...b,kind:'fire',context:ctx('take')}),/cannot be removed/i);
 roll('hit');roll('set-again');const repeated=roll('hit-again');assert.deepEqual(repeated.firePoints,[4]);roll('next-point');roll('seven-out');assert.equal(store.account('a').balance,991);assert.equal(store.assertAccounting(),true);
});

test('old active tables cannot start a fire wager mid-hand when history is unavailable',t=>{
 const {games,db}=setup(t,[]),b={guildId:'g',channelId:'c',userId:'a'};
 db.prepare("INSERT INTO point_craps_rounds(guild_id,channel_id,shooter,state,updated_at) VALUES ('g','c','a','open',1000)").run();
 assert.throws(()=>games.crapsWager({...b,kind:'fire',stake:2,context:ctx('fire')}),/before.*first point/i);
});

test('multiple fire bettors survive a restart and settle independently',t=>{
 const dice=[2,2,2,2,2,3,2,3,3,3,3,3,4,4,4,4,4,5,3,4],{games,store,db}=setup(t,dice),a={guildId:'g',channelId:'c',userId:'a'};
 let round=games.crapsJoin({...a,pick:'pass',stake:1,context:ctx('join')});games.crapsWager({...a,kind:'fire',stake:1,context:ctx('fire-a')});games.crapsWager({...a,userId:'b',kind:'fire',stake:2,context:ctx('fire-b','b')});
 for(let n=0;n<5;n++){let out=games.crapsRoll({...a,roundId:round.id,context:ctx('before'+n)});if(out.nextRoundId)round={id:out.nextRoundId};}
 let i=10;const restarted=new PointGames(new PredictionStore(db),{randomInt:()=>dice[i++]-1});
 for(let n=5;n<10;n++){let out=restarted.crapsRoll({...a,roundId:round.id,context:ctx('after'+n)});if(out.nextRoundId)round={id:out.nextRoundId};}
 assert.equal(store.account('a').balance,1025);assert.equal(store.account('b').balance,1048);assert.equal(store.assertAccounting(),true);
});
test('Discord commands accept horn and fire and the panel offers both',async t=>{
 const {games,store}=setup(t,[]),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'c',clock:()=>1000});
 const m={id:'1',guild:{id:'g'},channel:{id:'c',send:async p=>messages.push(p)},author:{id:'a'}};await registry.get('craps')(m,['join','pass','1']);m.id='2';await registry.get('craps')(m,['fire','2']);assert.match(messages.at(-1).content,/fire/);
 m.id='3';await registry.get('craps')(m,['horn','4']);assert.match(messages.at(-1).content,/horn/);m.id='4';await registry.get('craps')(m,['table']);
 const choices=messages.at(-1).components.flatMap(row=>row.components.flatMap(component=>component.options||[])).map(o=>o.value);assert.ok(choices.includes('horn'));assert.ok(choices.includes('fire'));assert.equal(store.account('a').balance,993);assert.equal(store.assertAccounting(),true);
});

test('failed fire payout rolls back the final roll and can be safely retried',t=>{
 const dice=[2,2,2,2,2,3,2,3,3,3,3,3,4,4,4,4,4,5,3,4],{games,store,db}=setup(t,dice),b={guildId:'g',channelId:'c',userId:'a'};
 let r=games.crapsJoin({...b,pick:'pass',stake:1,context:ctx('join')});games.crapsWager({...b,kind:'fire',stake:1,context:ctx('fire')});
 for(let n=0;n<9;n++){const x=games.crapsRoll({...b,roundId:r.id,context:ctx('r'+n)});if(x.nextRoundId)r={id:x.nextRoundId};}
 db.exec("CREATE TRIGGER fail_fire BEFORE INSERT ON prediction_transactions WHEN NEW.kind='house_funding' BEGIN SELECT RAISE(ABORT,'fire failure'); END");
 assert.throws(()=>games.crapsRoll({...b,roundId:r.id,context:ctx('fail')}),/fire failure/);assert.equal(store.account('a').balance,1000);assert.equal(games.crapsStatus(b).point,9);assert.equal(store.assertAccounting(),true);
 db.exec('DROP TRIGGER fail_fire');const retry=new PointGames(store,{randomInt:(()=>{let i=0;return ()=>[2,3][i++];})()});retry.crapsRoll({...b,roundId:r.id,context:ctx('retry')});assert.equal(store.account('a').balance,1025);assert.equal(store.assertAccounting(),true);
});
