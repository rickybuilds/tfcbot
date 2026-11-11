'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store'),{PointGames}=require('../predictions/games');
const user='222222222222222',owner='123456789012345';
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());const store=new PredictionStore(db),games=new PointGames(store,{randomInt:()=>1}),registry=new Map(),messages=[];require('../predictions/loan').register(registry,{store,config:{predictionsOwnerId:owner},clock:()=>1000});let n=0;return {store,games,messages,ctx:()=>({operationKey:'op'+(++n),actorId:user,now:1000}),run:async(args,actor=owner,id='loan1')=>registry.get('loan')({id,guild:{id:'g'},author:{id:actor},channel:{send:async p=>messages.push(p)}},args)};}
test('owner issues capped loans using casino wagers and charges rounded interest',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});
 await x.run([user,'26']);assert.match(x.messages.at(-1).content,/limit/i);await x.run([user,'25'],owner,'loan2');assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,25);assert.equal(x.store.loanStatus(user).interest,3);assert.equal(x.store.assertAccounting(),true);
 await x.run([user,'1'],owner,'loan3');assert.match(x.messages.at(-1).content,/limit/i);await x.run([user,'1'],'999999999999999','loan4');assert.equal(x.store.account(user).balance,925);
});
test('casino win automatically repays only profit, leaves stake intact, and replays safely',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);
 const context=x.ctx(),args={guildId:'g',userId:user,pick:'red',stake:10,context};x.games.roulette(args);x.games.roulette(args);
 assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,15);assert.equal(x.store.loanStatus(user).interest,3);assert.equal(x.store.assertAccounting(),true);
});
test('casino refunds and outstanding wagers do not increase the loan limit',async t=>{
 const x=setup(t);const context=x.ctx();x.games.crapsJoin({guildId:'g',channelId:'c',userId:user,pick:'pass',stake:100,context});
 assert.equal(x.store.loanStatus(user).limit,0);x.games.crapsCancel({guildId:'g',channelId:'c',userId:user,context:x.ctx()});assert.equal(x.store.loanStatus(user).limit,0);assert.equal(x.store.assertAccounting(),true);
});

test('winning profit pays principal then interest without taking extra and preserves remaining winnings',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);
 x.games.roulette({guildId:'g',userId:user,pick:'red',stake:50,context:x.ctx()});assert.equal(x.store.account(user).balance,947);assert.equal(x.store.loanStatus(user).principal,0);assert.equal(x.store.loanStatus(user).interest,0);assert.equal(x.store.assertAccounting(),true);
});
test('prediction winning profit also repays the loan but rewards and stake are not seized',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);
 const snapshot={matchId:'match',blueIds:['b1','b2','b3','b4'],redIds:['r1','r2','r3','r4'],offenseIds:[],serverKey:'east',mapName:'map'};
 const m=x.store.createMarket(snapshot,x.ctx());x.store.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:user,pick:'blue',stake:100,context:x.ctx()});x.store.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:'other',pick:'red',stake:100,context:x.ctx()});x.store.closeMarket(m.id,x.ctx());x.store.settleMarket({marketId:m.id,outcome:'blue',context:x.ctx()});
 assert.equal(x.store.account(user).balance,967);assert.equal(x.store.loanStatus(user).principal,0);assert.equal(x.store.loanStatus(user).interest,0);assert.equal(x.store.assertAccounting(),true);
});
test('loan issuance is idempotent and rolls back on accounting failure',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);await x.run([user,'25']);assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,25);
 x.store.db.exec("CREATE TRIGGER fail_loan BEFORE INSERT ON prediction_transactions WHEN NEW.kind='loan_advance' BEGIN SELECT RAISE(ABORT,'no'); END");
 x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'10'],owner,'loan-other');assert.equal(x.store.loanStatus(user).principal,25);assert.equal(x.store.assertAccounting(),true);
});

test('blackjack natural repays debt from its profit',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);
 let r=x.games.blackjackOpen({guildId:'g',channelId:'c',context:x.ctx()});const cards=[1,13,10,9].map((rank,i)=>({rank,suit:['♠','♥','♦','♣'][i]}));x.store.db.prepare('UPDATE point_blackjack_rounds SET shoe=?,shoe_pos=0 WHERE id=?').run(JSON.stringify(cards),r.id);
 r=x.games.blackjackJoin({roundId:r.id,guildId:'g',channelId:'c',userId:user,seat:1,stake:20,context:x.ctx()});r=x.games.blackjackDeal({roundId:r.id,guildId:'g',channelId:'c',userId:user,context:x.ctx()});
 assert.equal(r.state,'settled');assert.equal(x.store.account(user).balance,927);assert.equal(x.store.loanStatus(user).principal,0);assert.equal(x.store.loanStatus(user).interest,0);assert.equal(x.store.assertAccounting(),true);
});
test('craps line winnings repay debt from profit',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);x.games.randomInt=()=>2;
 const r=x.games.crapsJoin({guildId:'g',channelId:'c',userId:user,pick:'pass',stake:10,context:x.ctx()});x.games.randomInt=(()=>{let i=0;return()=>i++%2?3:2;})();x.games.crapsRoll({guildId:'g',channelId:'c',userId:user,roundId:r.id,context:x.ctx()});
 assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,15);assert.equal(x.store.assertAccounting(),true);
});

test('bank privately displays loan balance and borrowing capacity',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.run([user,'25']);
 const {createPredictions}=require('../predictions');const svc=createPredictions({db:x.store.db,config:{predictionsEnabled:false},clock:()=>1000,logger:{warn:()=>{}}});let dm;
 await svc.handleBankCommand({id:'bank',guild:{id:'g',name:'Guild'},author:{id:user,send:async p=>{dm=p;}},delete:async()=>{},channel:{send:async()=>{}}},'bank');
 const output=dm.content||dm.files[0].attachment.toString();assert.match(output,/25 principal \+ 3 interest/);assert.match(output,/automatically repays/);
});
