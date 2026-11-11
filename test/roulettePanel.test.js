'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store'),{PointGames}=require('../predictions/games');
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());const store=new PredictionStore(db);return {store,games:new PointGames(store,{randomInt:()=>0})};}
test('roulette table offers all supported bets and number betting',async t=>{
 const {games}=setup(t),registry=new Map(),messages=[];require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'casino'});
 await registry.get('roulette')({id:'1',guild:{id:'g'},author:{id:'a'},channel:{id:'casino',send:async p=>messages.push(p)}},[]);
 const controls=messages[0].components.flatMap(row=>row.components).map(b=>b.custom_id);
 for(const pick of ['red','black','odd','even','low','high','number'])assert.ok(controls.includes('point-roulette:bet:'+pick),pick);
});
test('roulette button opens a wager form',async t=>{
 const {games}=setup(t),registry=new Map();const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'casino'});let modal;
 await handle({customId:'point-roulette:bet:red',guildId:'g',channelId:'casino',user:{id:'a'},isButton:()=>true,showModal:async m=>{modal=m.toJSON();}});
 assert.equal(modal.custom_id,'point-roulette:stake:red');
});
test('roulette wager settles once and displays a green zero result',async t=>{
 const {games,store}=setup(t),registry=new Map(),updates=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'casino',clock:()=>1000,rouletteRevealDelay:0});
 const i={id:'spin1',customId:'point-roulette:stake:red',guildId:'g',channelId:'casino',user:{id:'a'},isModalSubmit:()=>true,fields:{getTextInputValue:()=> '10'},reply:async p=>updates.push(p),editReply:async p=>updates.push(p)};
 await handle(i);assert.equal(store.account('a').balance,990);assert.equal(updates.length,2);assert.match(JSON.stringify(updates[1]),/green/i);assert.match(JSON.stringify(updates[1]),/0 points returned/i);
});

test('roulette number wager validates and pays 35 to 1 on zero',async t=>{
 const {games,store}=setup(t),registry=new Map(),updates=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'casino',clock:()=>1000,rouletteRevealDelay:0});
 const i={id:'number1',customId:'point-roulette:stake:number',guildId:'g',channelId:'casino',user:{id:'a'},isModalSubmit:()=>true,fields:{getTextInputValue:id=>id==='number'?'0':'10'},reply:async p=>updates.push(p),editReply:async p=>updates.push(p)};
 await handle(i);assert.equal(store.account('a').balance,1350);assert.match(JSON.stringify(updates[1]),/360 points returned/);
});
test('roulette rejects invalid wagers privately without spinning',async t=>{
 const {games,store}=setup(t),registry=new Map(),updates=[];const handle=require('../predictions/gameCommands').register(registry,games,{casinoChannelId:'casino',rouletteRevealDelay:0});
 await handle({id:'bad',customId:'point-roulette:stake:number',guildId:'g',channelId:'casino',user:{id:'a'},isModalSubmit:()=>true,fields:{getTextInputValue:id=>id==='number'?'37':'10'},reply:async p=>updates.push(p)});
 assert.equal(updates[0].ephemeral,true);assert.match(updates[0].content,/choose/i);assert.equal(store.account('a'),undefined);
});
