'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store');const {PointGames}=require('../predictions/games');
const setup=t=>{const db=new Database(':memory:');t.after(()=>db.close());const store=new PredictionStore(db);let n=0;return {db,store,games:new PointGames(store,{randomInt:max=>{n++;return 0;}}),ctx:(id,now=1000,actorId='a')=>({operationKey:id,actorId,now})};};
function sequence(t,draws){const x=setup(t);let i=0;x.games.randomInt=max=>{const n=draws[i++]??0;return Math.min(n,max-1);};return x;}
function shoe(games,roundId,ranks){games.store.db.prepare('UPDATE point_blackjack_rounds SET shoe=?,shoe_pos=0 WHERE id=?').run(JSON.stringify(ranks.map((rank,i)=>({rank,suit:['♠','♥','♦','♣'][i%4]}))),roundId);}
test('blackjack stake is escrowed, seat collision is rejected, and accounting balances',t=>{
 const {store,games,ctx}=sequence(t,Array(52).fill(0));const r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('open')});
 games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'a',seat:1,stake:500,context:ctx('join')});
 assert.equal(store.account('a').balance,500);assert.throws(()=>games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'b',seat:1,stake:10,context:ctx('collision',1001,'b')}),/taken/i);
 assert.equal(store.assertAccounting(),true);
});
test('blackjack natural pays 3:2 and settles ledger once',t=>{
 const {store,games,ctx}=sequence(t,[...Array.from({length:51},(_,i)=>i+1),12,0,0]);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o')});r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'a',seat:1,stake:100,context:ctx('j')});
 r=games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('d')});assert.equal(r.state,'settled');assert.equal(store.account('a').balance,1150);assert.equal(store.assertAccounting(),true);
});
test('blackjack double draws once, then dealer resolves the hand',t=>{
 const {store,games,ctx}=sequence(t,[0,1,0,2,0,3,0,4,0,5]);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o')});r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'a',seat:1,stake:100,context:ctx('j')});
 r=games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('d')});if(r.state==='settled')return;const h=r.seats[0].hands[0];r=games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'a',handId:h.id,action:'double',stake:100,context:ctx('double')});assert.ok(['playing','settled'].includes(r.state));assert.equal(store.assertAccounting(),true);
});
test('expired empty blackjack table closes without a deal',t=>{
 const {games,ctx}=sequence(t,Array(52).fill(0));const r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o')});const closed=games.blackjackExpire({roundId:r.id,expectedDeadline:r.deadline,context:ctx('expire',r.deadline,'system')});assert.equal(closed.state,'cancelled');
});
test('only the user who opened the table can deal early',t=>{
 const {games,ctx}=setup(t);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o',1000,'opener')});shoe(games,r.id,[10,9,8,7]);r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'seated',seat:1,stake:100,context:ctx('j',1001,'seated')});
 assert.throws(()=>games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'seated',context:ctx('wrong-deal',1002,'seated')}),/opened the blackjack table/i);
 r=games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'opener',context:ctx('owner-deal',1002,'opener')});assert.equal(r.state,'playing');
});
test('split holds a second wager, plays both hands in order, and settles each hand',t=>{
 const {store,games,ctx}=setup(t);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o')});shoe(games,r.id,[8,8,10,7,10,2,3]);r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'a',seat:1,stake:500,context:ctx('j')});
 r=games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('d')});let h=r.seats[0].hands[0];r=games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'a',handId:h.id,action:'split',stake:500,context:ctx('split')});assert.equal(r.seats[0].hands.length,2);assert.equal(store.account('a').balance,0);assert.equal(store.assertAccounting(),true);
 h=r.seats[0].hands[0];r=games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'a',handId:h.id,action:'stand',context:ctx('stand1')});h=r.seats[0].hands[1];r=games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'a',handId:h.id,action:'stand',context:ctx('stand2')});assert.equal(r.state,'settled');assert.equal(r.seats[0].hands[0].result,'win');assert.equal(r.seats[0].hands[1].result,'loss');assert.equal(store.account('a').balance,1000);assert.equal(store.assertAccounting(),true);
});
test('a playing hand auto-stands when its 60-second turn expires',t=>{
 const {games,ctx}=setup(t);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o')});shoe(games,r.id,[10,7,9,8]);r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:'a',seat:1,stake:50,context:ctx('j')});r=games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:'a',context:ctx('d')});const timed=games.blackjackExpire({roundId:r.id,expectedDeadline:r.deadline,context:ctx('timeout',r.deadline,'system')});assert.equal(timed.state,'settled');
});
test('multiple players take turns by seat and cannot act for another player',t=>{
 const {store,games,ctx}=setup(t);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('o',1000,'p1')});shoe(games,r.id,[10,9,8,7,6,5,4,3,2,2,10,8]);
 for(let seat=1;seat<=5;seat++)r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:`p${seat}`,seat,stake:100,context:ctx(`j${seat}`,1000,`p${seat}`)});
 assert.equal(r.state,'playing');assert.equal(r.seats.length,5);assert.equal(r.current_seat,1);const first=r.seats[0].hands[0];
 assert.throws(()=>games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'p2',handId:first.id,action:'stand',context:ctx('wrong',1001,'p2')}),/hand owner/i);
 r=games.blackjackAction({roundId:r.id,guildId:'g',channelId:'c',userId:'p1',handId:first.id,action:'stand',context:ctx('s1',1001,'p1')});assert.equal(r.current_seat,2);assert.equal(store.assertAccounting(),true);
});
test('!blackjack opens a five-seat public casino table only once',async t=>{
 const {games}=setup(t),registry=new Map(),sent=[];require('../predictions/gameCommands').register(registry,games,{clock:()=>1000,casinoChannelId:'casino'});const msg={id:'open-msg',guild:{id:'g'},author:{id:'a'},channel:{id:'casino',send:async p=>{sent.push(p);return {id:'table-msg'};}}};await registry.get('blackjack')(msg,[]);await registry.get('blackjack')(msg,[]);assert.equal(sent.length,2);assert.equal(sent[0].components[0].components.length,5);assert.match(sent[0].embeds[0].description,/closes/);assert.match(sent[1].content,/already open/i);
});


test('blackjack panel presents a settled round in an embed',()=>{
 const {panel}=require('../predictions/blackjackPanel');
 const result=panel({id:1,state:'settled',dealerCards:[{rank:10,suit:'♣'},{rank:9,suit:'♦'}],seats:[{seat:2,user_id:'123',hands:[{hand_no:1,cards:[{rank:10,suit:'♥'},{rank:8,suit:'♠'}],state:'settled',result:'loss',stake:100}]}]});
 assert.equal(result.content,null);
 assert.match(result.embeds[0].title,/Blackjack/);
 const text=JSON.stringify(result.embeds[0]);
 for(const expected of ['Dealer','19','<@123>','18','loss','100','Round settled']) assert.ok(text.includes(expected),expected);
 assert.deepEqual(result.allowedMentions,{parse:[]});
});


test('joining a blackjack seat updates the table without a confirmation message',async t=>{
 const {games,ctx}=setup(t);const round=games.blackjackOpen({guildId:'g',channelId:'casino',context:ctx('open')});
 const {handleModal}=require('../predictions/blackjackPanel');let deferred=0,refreshed;
 const interaction={customId:`point-bj:stake:${round.id}:1`,id:'modal',guildId:'g',channelId:'casino',user:{id:'player'},isModalSubmit:()=>true,fields:{getTextInputValue:()=> '100'},deferUpdate:async()=>{deferred++;},reply:async()=>{throw new Error('unexpected confirmation');}};
 assert.equal(await handleModal(interaction,games,{casinoChannelId:'casino',clock:()=>1001,refresh:async r=>{refreshed=r;}}),true);
 assert.equal(deferred,1);assert.equal(refreshed.seats[0].user_id,'player');assert.equal(refreshed.seats[0].stake,100);
});

test('invalid blackjack seat wagers still receive a private error',async t=>{
 const {games,ctx}=setup(t);const round=games.blackjackOpen({guildId:'g',channelId:'casino',context:ctx('open')});
 const {handleModal}=require('../predictions/blackjackPanel');let reply;
 const interaction={customId:`point-bj:stake:${round.id}:1`,id:'modal',guildId:'g',channelId:'casino',user:{id:'player'},isModalSubmit:()=>true,fields:{getTextInputValue:()=> 'invalid'},deferUpdate:async()=>{throw new Error('unexpected update');},reply:async payload=>{reply=payload;}};
 await handleModal(interaction,games,{casinoChannelId:'casino',clock:()=>1001});assert.equal(reply.ephemeral,true);assert.ok(reply.content);
});


test('the fifth seat deals automatically and replaying the join does not deal twice',t=>{
 const {games,store,ctx}=setup(t);let r=games.blackjackOpen({guildId:'g',channelId:'c',context:ctx('open',1000,'opener')});shoe(games,r.id,[10,9,8,7,6,5,4,3,2,2,10,8]);const oldDeadline=r.deadline;
 for(let seat=1;seat<=4;seat++){r=games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:`p${seat}`,seat,stake:100,context:ctx(`join${seat}`,1000,`p${seat}`)});assert.equal(r.state,'joining');}
 const args={roundId:r.id,guildId:'g',channelId:'c',userId:'p5',seat:5,stake:100,context:ctx('join5',1001,'p5')};r=games.blackjackJoin(args);
 assert.equal(r.state,'playing');assert.equal(r.seats.length,5);assert.ok(r.seats.every(s=>s.hands.length===1&&s.hands[0].cards.length===2));assert.equal(r.current_seat,1);assert.equal(r.deadline,61001);
 assert.deepEqual(games.blackjackJoin(args),r);const stale=games.blackjackExpire({roundId:r.id,expectedDeadline:oldDeadline,context:ctx('old-timer',oldDeadline,'system')});assert.equal(stale.current_seat,1);assert.equal(store.assertAccounting(),true);
});
