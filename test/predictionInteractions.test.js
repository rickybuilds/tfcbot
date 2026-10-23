"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){const db=new Database(":memory:");t.after(()=>db.close());const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>1000});const m=s.onMatchFinalized({matchId:"MATCH1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});return {s,m};}
function interaction(id,customId,user="u",amount="100"){return {id,customId,user:{id:user},guildId:"guild",isButton:()=>!customId.includes(":submit:"),isModalSubmit:()=>customId.includes(":submit:"),fields:{getTextInputValue:()=>amount},reply:async function(p){this.response=p;this.replied=true;},showModal:async function(p){this.modal=p.toJSON();}};}
test("outcome opens private modal; submit validates cap and privately debits once",async t=>{
 const {s,m}=setup(t);const click=interaction("click",`pred:pick:${m.id}:1:blue`);await s.handleInteraction(click);assert.ok(click.modal);assert.equal(click.modal.components[0].components[0].label,"Stake (1–100 points)");assert.equal(click.modal.components[0].components[0].max_length,16);
 const submit=interaction("submit",click.modal.custom_id);await s.handleInteraction(submit);assert.equal(submit.response.flags,64);assert.equal(s.store.account("u").balance,900);
 await s.handleInteraction(interaction("submit",click.modal.custom_id));assert.equal(s.store.account("u").balance,900);
 const bad=interaction("bad",click.modal.custom_id,"u","1e2");await s.handleInteraction(bad);assert.match(bad.response.content,/whole number/i);
});
test("My Bet is private without a bet and cancel refunds before closure",async t=>{
 const {s,m}=setup(t);const mine=interaction("mine",`pred:mine:${m.id}:1`);await s.handleInteraction(mine);assert.equal(mine.response.flags,64);assert.match(mine.response.content,/1,000/);assert.match(mine.response.content,/You have no bet on this game\./);assert.match(mine.response.content,/Max bet for this game: 100 points/);assert.match(mine.response.content,/0 settled games/);
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"red",stake:100,context:s.context("bet","u")});
 const cancel=interaction("cancel",`pred:cancel:${m.id}:1`);await s.handleInteraction(cancel);assert.equal(s.store.account("u").balance,1000);
});
test("earned limits above 250 appear privately and allow larger stakes while forged excessive inputs are rejected",async t=>{
 const {s,m}=setup(t);
 for(let n=0;n<16;n++){
  const game=s.store.createMarket({...m.snapshot,matchId:`HISTORY_${n}`},s.context("create"));
  s.store.placeBet({marketRef:{marketId:game.id,revision:1},discordId:"u",pick:"blue",stake:1,context:s.context("history","u")});
  s.store.closeMarket(game.id,s.context());s.store.settleMarket({marketId:game.id,outcome:"tie",context:s.context()});
 }
 const click=interaction("higher",`pred:pick:${m.id}:1:blue`);await s.handleInteraction(click);assert.equal(click.modal.components[0].components[0].label,"Stake (1–260 points)");
 const excessive=interaction("over",click.modal.custom_id,"u","261");await s.handleInteraction(excessive);assert.match(excessive.response.content,/260/);assert.equal(s.store.bets(m.id).length,0);
 const submit=interaction("larger",click.modal.custom_id,"u","260");await s.handleInteraction(submit);assert.match(submit.response.content,/stake 260/);assert.equal(s.store.account("u").balance,740);
 const mine=interaction("higher-mine",`pred:mine:${m.id}:1`);await s.handleInteraction(mine);assert.match(mine.response.content,/Max bet for this game: 260 points/);assert.match(mine.response.content,/16 settled games/);
});
test("forged/stale/participant actions are private errors; public cards contain no financial detail",async t=>{
 const {s,m}=setup(t);const stale=interaction("stale",`pred:submit:${m.id}:99:blue`);await s.handleInteraction(stale);assert.equal(stale.response.flags,64);assert.match(stale.response.content,/stale/i);
 const participant=interaction("part",`pred:submit:${m.id}:1:blue`,"b1");await s.handleInteraction(participant);assert.match(participant.response.content,/participant/i);
 const {cardUpdate}=require("../predictions/messages");const card=JSON.stringify(cardUpdate(s.store.market(m.id),1000));assert.doesNotMatch(card,/balance|stake|b1|r1/);
 s.store.closeMarket(m.id,s.context());const data=cardUpdate(s.store.market(m.id),1000);assert.equal(data.components[0].components[0].data.disabled,true);assert.notEqual(data.components[0].components[3].data.disabled,true);
});
