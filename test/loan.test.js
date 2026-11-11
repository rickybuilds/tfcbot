'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store'),{PointGames}=require('../predictions/games');
const user='222222222222222',owner='123456789012345';
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());const store=new PredictionStore(db),games=new PointGames(store,{randomInt:()=>1}),registry=new Map(),messages=[],service={store,config:{predictionsOwnerId:owner},clock:()=>1000};const loan=require('../predictions/loan');loan.register(registry,service);let n=0;const offer=async(args,actor=owner,id='loan1')=>registry.get('loan')({id,guild:{id:'guild'},author:{id:actor},channel:{id:'channel',send:async p=>messages.push(p)}},args);const run=async(args,actor=owner,id='loan1')=>{await offer(args,actor,id);const result=messages.at(-1);if(result?.components){await loan.handleInteraction({customId:`point-loan:accept:${id}`,id:`click-${id}`,guildId:'guild',channelId:'channel',user:{id:user},isButton:()=>true,update:async()=>{},reply:async()=>{}},service);}};return {store,games,messages,offer,run,ctx:()=>({operationKey:'op'+(++n),actorId:user,now:1000})};}
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


test('loan offer requires the named player to accept the displayed terms',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});
 await x.offer([user,'25']);assert.equal(x.store.account(user).balance,900);assert.equal(x.store.loanStatus(user).principal,0);assert.match(x.messages.at(-1).content,/25.*3.*28/s);assert.match(x.messages.at(-1).content,/profit/i);
 const {handleInteraction}=require('../predictions/loan');let reply;const interaction={customId:'point-loan:accept:loan1',id:'click1',guildId:'guild',channelId:'channel',user:{id:'other'},isButton:()=>true,reply:async p=>{reply=p;},update:async()=>{throw Error('unauthorized update');}};
 await handleInteraction(interaction,{store:x.store,clock:()=>1000});assert.equal(reply.ephemeral,true);assert.equal(x.store.account(user).balance,900);
 interaction.user.id=user;let update;interaction.update=async p=>{update=p;};await handleInteraction(interaction,{store:x.store,clock:()=>1000});assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,25);assert.match(update.content,/accepted/i);assert.equal(x.store.assertAccounting(),true);
 await handleInteraction({...interaction,id:'click2'}, {store:x.store,clock:()=>1000});assert.equal(x.store.account(user).balance,925);
});

test('declined and expired offers never credit points',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.offer([user,'25'],owner,'decline');
 const loan=require('../predictions/loan');let reply,updated;const click={customId:'point-loan:decline:decline',guildId:'guild',channelId:'channel',user:{id:user},isButton:()=>true,update:async p=>{updated=p;},reply:async p=>{reply=p;}};
 await loan.handleInteraction(click,{store:x.store,clock:()=>1000});assert.match(updated.content,/declined/);assert.equal(x.store.account(user).balance,900);
 await x.offer([user,'25'],owner,'expired');click.customId='point-loan:accept:expired';await loan.handleInteraction(click,{store:x.store,clock:()=>901000});assert.match(reply.content,/expired/);assert.equal(x.store.account(user).balance,900);assert.equal(x.store.loanStatus(user).principal,0);
});
test('accepting a second offer rechecks the borrowing limit',async t=>{
 const x=setup(t);x.games.roulette({guildId:'g',userId:user,pick:'black',stake:100,context:x.ctx()});await x.offer([user,'25'],owner,'first');await x.offer([user,'25'],owner,'second');
 const loan=require('../predictions/loan');let reply;const click={customId:'point-loan:accept:first',guildId:'guild',channelId:'channel',user:{id:user},isButton:()=>true,update:async()=>{},reply:async p=>{reply=p;}};
 await loan.handleInteraction(click,{store:x.store,clock:()=>1000});click.customId='point-loan:accept:second';await loan.handleInteraction(click,{store:x.store,clock:()=>1000});assert.match(reply.content,/limit/i);assert.equal(x.store.account(user).balance,925);assert.equal(x.store.loanStatus(user).principal,25);assert.equal(x.store.assertAccounting(),true);
});
