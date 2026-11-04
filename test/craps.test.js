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
