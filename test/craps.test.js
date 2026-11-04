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
 const i={id:'103',customId:button.custom_id,guildId:'g',channelId:'c',user:{id:'b'},isButton:()=>true,reply:async p=>{output=p}};
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
