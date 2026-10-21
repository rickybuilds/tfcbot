"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){
 const db=new Database(":memory:");t.after(()=>db.close());
 db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY); CREATE TABLE rating_changes(match_id TEXT); INSERT INTO matches VALUES('DELETED')");
 const edits=[],sent=[];let failEdit=false;
 const card={edit:async payload=>{if(failEdit)throw new Error("Discord unavailable");edits.push(payload);}};
 const client={channels:{fetch:async()=>({messages:{fetch:async()=>card}})}};
 const s=createPredictions({db,client,config:{predictionsEnabled:true,predictionsOwnerId:"owner"},clock:()=>1000,logger:{warn:()=>{}}});
 const m=s.onMatchFinalized({matchId:"DELETED",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});
 s.bindMessage(m.id,{channelId:"pickup",id:"card"});
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("bet","spectator")});
 const message={author:{id:"owner"},member:{permissions:{has:()=>true},roles:{cache:{has:()=>true}}},channel:{id:"pickup",send:async payload=>sent.push(payload)}};
 t.after(()=>s.stop());return {s,db,m,client,card,edits,sent,message,fail:value=>{failEdit=value;},remove:()=>db.prepare("DELETE FROM matches WHERE match_id='DELETED'").run()};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function assertVoidedCard(payload){assert.match(payload.content,/voided.*refunded/i);assert.equal(payload.components[0].components[0].data.disabled,true);assert.equal(payload.components[0].components[1].data.disabled,true);assert.equal(payload.components[0].components[2].data.disabled,true);assert.notEqual(payload.components[0].components[3].data.disabled,true);}

test("delmatch refunds the bet and refreshes the original card so deleted games cannot appear open",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,edits,sent}=setup(t),reg=new Map();
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});
 await reg.get("delmatch")(message,["DELETED"]);await flush();
 assert.match(sent[0],/deleted/);assert.equal(s.store.market(m.id).state,"void");assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.bets(m.id)[0].status,"refunded");
 assert.equal(edits.length,1);assertVoidedCard(edits[0]);
 assert.throws(()=>s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"red",stake:100,context:s.context("late","spectator")}),/closed/);assert.equal(s.store.assertAccounting(),true);
});
test("failed match deletion rolls back refunds and never publishes a voided card",async t=>{
 const {s,db,m,edits}=setup(t);
 assert.throws(()=>s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:()=>{throw new Error("delete failed");}}),/delete failed/);await flush();await s.retryPendingCards();
 assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.account("spectator").balance,900);assert.equal(s.store.bets(m.id)[0].status,"active");assert.equal(edits.length,0);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches").get().n,1);assert.equal(s.store.assertAccounting(),true);
});
test("failed card edits survive restart and retry without paying the refund again",async t=>{
 const {s,db,m,client,edits,fail,remove}=setup(t);fail(true);
 s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:remove});await flush();assert.equal(edits.length,0);assert.equal(s.store.account("spectator").balance,1000);
 const history=db.prepare("SELECT COUNT(*) AS n FROM prediction_transactions").get().n;fail(false);
 const recovered=createPredictions({db,client,config:{predictionsEnabled:false},clock:()=>1000,logger:{warn:()=>{}}});t.after(()=>recovered.stop());
 await recovered.initialize();assert.equal(edits.length,1);assertVoidedCard(edits[0]);
 await recovered.retryPendingCards();assert.equal(edits.length,1);assert.equal(s.store.account("spectator").balance,1000);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_transactions").get().n,history);
});
test("deletion before an outstanding message is bound still refreshes that message when available",async t=>{
 const {s,db,m,edits,remove}=setup(t);db.prepare("UPDATE prediction_markets SET message_id=NULL WHERE id=?").run(m.id);
 s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:remove});await flush();assert.equal(edits.length,0);
 s.bindMessage(m.id,{channelId:"pickup",id:"late-card"});await s.retryPendingCards();assertVoidedCard(edits.at(-1));
});
test("an outer transaction rollback removes the queued deletion refresh before Discord work starts",async t=>{
 const {s,db,m,edits,remove}=setup(t);
 assert.throws(()=>db.transaction(()=>{s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:remove});throw new Error("outer rollback");})(),/outer rollback/);
 await flush();await s.retryPendingCards();assert.equal(edits.length,0);assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.account("spectator").balance,900);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_meta WHERE key GLOB 'card_refresh:*'").get().n,0);
});
test("a delayed pre-deletion edit cannot erase the retry needed to correct stale open buttons",async t=>{
 const {s,db,m,card,remove}=setup(t);let entered,release,displayed,calls=0;
 const started=new Promise(resolve=>{entered=resolve;});
 card.edit=async payload=>{if(++calls===1){entered();await new Promise(resolve=>{release=resolve;});}displayed=payload;};
 const oldEdit=s.refreshCard(m.id);await started;
 s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:remove});await flush();assertVoidedCard(displayed);
 release();await oldEdit;assert.match(displayed.content,/Predictions open/);
 await s.retryPendingCards();assertVoidedCard(displayed);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_meta WHERE key GLOB 'card_refresh:*'").get().n,0);assert.equal(s.store.account("spectator").balance,1000);
});
test("My Bet repairs a stale card for a game deleted before the refresh fix was installed",async t=>{
 const {s,m,edits,remove}=setup(t);
 s.store.voidMarket({marketId:m.id,context:s.context("legacy-delete")});remove();assert.equal(edits.length,0);
 const click={id:"my-bet",customId:`pred:mine:${m.id}:1`,user:{id:"spectator"},message:{id:"card"},reply:async payload=>{click.response=payload;}};
 await s.handleInteraction(click);await flush();assert.match(click.response.content,/void/);assert.match(click.response.content,/refunded/);assert.equal(click.response.flags,64);
 assertVoidedCard(edits.at(-1));assert.equal(s.store.account("spectator").balance,1000);
});
