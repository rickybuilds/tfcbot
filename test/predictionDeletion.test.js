"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){
 const db=new Database(":memory:");t.after(()=>db.close());
 db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,status TEXT DEFAULT 'in_progress'); CREATE TABLE ratings(player_id TEXT PRIMARY KEY,rating INTEGER); CREATE TABLE rating_changes(id INTEGER PRIMARY KEY,match_id TEXT,player_id TEXT,after INTEGER); INSERT INTO matches(match_id) VALUES('DELETED')");
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

test("deletion retains corrected settled payouts and audits the admin without owner intervention",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,sent}=setup(t),reg=new Map();
 s.store.closeMarket(m.id,s.context("close"));s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context("settle")});s.store.correctSettlement({marketId:m.id,outcome:"red",context:s.context("correct","owner","correct result")});
 const before=s.store.market(m.id),balance=s.store.account("spectator").balance,ledger=db.prepare("SELECT * FROM prediction_transactions ORDER BY id").all();
 message.author.id="admin-id";
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});
 await reg.get("delmatch")(message,["DELETED","invalid","match"]);
 assert.match(sent[0],/deleted/i);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,0);
 const after=s.store.market(m.id);assert.equal(after.result,before.result);assert.equal(after.settlement_version,2);assert.equal(s.store.account("spectator").balance,balance);
 assert.deepEqual(db.prepare("SELECT * FROM prediction_transactions WHERE id<=? ORDER BY id").all(ledger.at(-1).id),ledger);
 const audit=db.prepare("SELECT * FROM match_deletion_audit WHERE match_id=?").get("DELETED");assert.equal(audit.actor_id,"admin-id");assert.equal(audit.reason,"invalid match");assert.equal(JSON.parse(audit.markets)[0].previousState,"settled");
 s.reconcileCompletedMatches();assert.equal(s.store.account("spectator").balance,balance);assert.equal(s.store.market(m.id).settlement_version,2);
});

test("elo rollback failure rolls back prediction refunds and preserves match and rating history",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,sent}=setup(t),reg=new Map();db.exec("INSERT INTO rating_changes(match_id) VALUES ('DELETED')");
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{throw new Error("injected rollback failure");}},matchesStore:{},predictions:s});
 await reg.get("delmatch")(message,["DELETED"]);
 assert.match(sent[0],/failed/i);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM rating_changes").get().n,1);assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.account("spectator").balance,900);
});

test("multiple historical and current markets are handled independently and duplicate deletion is harmless",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,sent}=setup(t),reg=new Map();
 s.store.voidMarket({marketId:m.id,context:s.context("old-void","owner","old terms")});
 const second=s.store.createMarket(m.snapshot,s.context("replacement"));s.store.placeBet({marketRef:{marketId:second.id,revision:second.revision},discordId:"spectator",pick:"red",stake:100,context:s.context("bet2","spectator")});s.store.closeMarket(second.id,s.context("close"));
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});
 await reg.get("delmatch")(message,["DELETED"]);const count=db.prepare("SELECT count(*) n FROM prediction_transactions WHERE kind='refund'").get().n;
 await reg.get("delmatch")(message,["DELETED"]);assert.match(sent.at(-1),/no match/i);assert.equal(db.prepare("SELECT count(*) n FROM prediction_transactions WHERE kind='refund'").get().n,count);
 assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.market(m.id).state,"void");assert.equal(s.store.market(second.id).state,"void");
 const details=JSON.parse(db.prepare("SELECT markets FROM match_deletion_audit").get().markets);assert.deepEqual(details.map(x=>x.previousState),["void","closed"]);assert.equal(details[1].refunds[0].amount,100);
 assert.throws(()=>s.store.createMarket(m.snapshot,s.context("reuse")),/deleted match/i);assert.equal(s.store.assertAccounting(),true);
});
test("refund errors abort the deletion and leave all records unchanged",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,sent}=setup(t),reg=new Map();db.exec("CREATE TRIGGER reject_refund BEFORE INSERT ON prediction_transactions WHEN NEW.kind='refund' BEGIN SELECT RAISE(ABORT,'refund failure'); END");
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});
 await reg.get("delmatch")(message,["DELETED"]);assert.match(sent[0],/failed/i);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.account("spectator").balance,900);assert.equal(db.prepare("SELECT count(*) n FROM match_deletion_audit").get().n,0);
});
test("unauthorized users and wrong channels cannot delete matches",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message,sent}=setup(t),reg=new Map();require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});
 message.member.permissions.has=()=>false;message.member.roles.cache.has=()=>false;await reg.get("delmatch")(message,["DELETED"]);assert.match(sent[0],/permission/i);
 message.member.roles.cache.has=()=>true;message.channel.id="elsewhere";await reg.get("delmatch")(message,["DELETED"]);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);assert.equal(s.store.market(m.id).state,"open");assert.equal(s.store.account("spectator").balance,900);
});
test("recreated official rows cannot cause automatic settlement after deletion",async t=>{
 const previousRole=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(previousRole==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=previousRole;});
 const {s,db,m,message}=setup(t),reg=new Map();s.store.closeMarket(m.id,s.context("close"));s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context("settle")});
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});await reg.get("delmatch")(message,["DELETED"]);
 db.prepare("INSERT INTO matches(match_id,status) VALUES ('DELETED','completed')").run();const before=s.store.market(m.id);s.reconcileCompletedMatches();assert.deepEqual(s.store.market(m.id),before);
});

for(const state of ["countdown","closed","review_required"])test(`deletion refunds an unresolved ${state} market once`,async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});const {s,db,m,message}=setup(t),reg=new Map();
 if(state==="countdown")s.store.startCountdown(m.id,1000);else if(state==="closed")s.store.closeMarket(m.id,s.context("close"));else s.store.markReview(m.id,"investigate");
 require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});await reg.get("delmatch")(message,["DELETED"]);
 assert.equal(s.store.market(m.id).state,"void");assert.equal(s.store.market(m.id).reason,"Admin requested match deletion");assert.equal(s.store.account("spectator").balance,1000);assert.equal(db.prepare("SELECT count(*) n FROM prediction_transactions WHERE kind='refund'").get().n,1);assert.equal(s.store.assertAccounting(),true);
});
test("a match without predictions reverts real Elo history and records the outcome",async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});
 const {EloDB}=require("../lib/elo"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"delmatch-elo-"));const elo=new EloDB(path.join(dir,"test.db"));
 t.after(()=>{elo.db.close();fs.rmSync(dir,{recursive:true,force:true});});const db=elo.db;db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY); INSERT INTO matches VALUES ('NO-MARKET'); INSERT INTO ratings VALUES ('player','Player',2020); INSERT INTO rating_changes (match_id,ts,player_id,before,after,delta) VALUES ('NO-MARKET',1,'player',2000,2020,20)");
 const s=createPredictions({db,config:{predictionsEnabled:true}});t.after(()=>s.stop());const reg=new Map(),sent=[];require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo,matchesStore:{},predictions:s});
 const message={author:{id:"admin"},member:{roles:{cache:{has:()=>true}}},channel:{id:"pickup",send:async m=>sent.push(m)}};await reg.get("delmatch")(message,["NO-MARKET","test"]);
 assert.match(sent[0],/elo reverted/i);assert.equal(db.prepare("SELECT rating FROM ratings WHERE player_id='player'").get().rating,2000);assert.equal(db.prepare("SELECT count(*) n FROM rating_changes").get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,0);
 const audit=db.prepare("SELECT * FROM match_deletion_audit").get();assert.deepEqual(JSON.parse(audit.markets),[]);assert.deepEqual(JSON.parse(audit.elo_outcome),{status:"reverted",revertedCount:1});
});
test("a concurrent connection cannot bet or settle during the deletion transaction",async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});
 const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"delmatch-lock-")),file=path.join(dir,"test.db"),db=new Database(file),other=new Database(file,{timeout:1});
 t.after(()=>{other.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,status TEXT); CREATE TABLE ratings(player_id TEXT PRIMARY KEY,rating INTEGER); CREATE TABLE rating_changes(id INTEGER PRIMARY KEY,match_id TEXT,player_id TEXT,after INTEGER); INSERT INTO matches VALUES('LOCKED','in_progress'); INSERT INTO rating_changes(match_id) VALUES('LOCKED')");
 const s=createPredictions({db,config:{predictionsEnabled:true},clock:()=>1000}),second=createPredictions({db:other,config:{predictionsEnabled:true},clock:()=>1000});t.after(()=>{s.stop();second.stop();});
 const snap={matchId:"LOCKED",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"},m=s.onMatchFinalized(snap);s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",pick:"blue",stake:100,context:s.context("bet","spectator")});
 let attempts=0;const elo={db,unreportMatch(){assert.throws(()=>second.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"late",pick:"blue",stake:100,context:second.context("late","late")}),/locked/);attempts++;assert.throws(()=>second.store.settleMarket({marketId:m.id,outcome:"blue",context:second.context("settle")}),/locked/);attempts++;db.prepare("DELETE FROM rating_changes WHERE match_id='LOCKED'").run();return {revertedCount:1};}};
 const reg=new Map(),sent=[];require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo,matchesStore:{},predictions:s});await reg.get("delmatch")({author:{id:"admin"},member:{roles:{cache:{has:()=>true}}},channel:{id:"pickup",send:async x=>sent.push(x)}},["LOCKED"]);
 assert.equal(attempts,2);assert.match(sent[0],/deleted/i);assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.market(m.id).state,"void");assert.throws(()=>second.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"late",pick:"blue",stake:100,context:second.context("late2","late")}),/closed/);
});

test("the deletion audit is append-only",async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});const {s,db,message}=setup(t),reg=new Map();require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo:{db,unreportMatch:()=>{}},matchesStore:{},predictions:s});await reg.get("delmatch")(message,["DELETED"]);
 assert.throws(()=>db.prepare("DELETE FROM match_deletion_audit").run(),/append-only/);assert.throws(()=>db.prepare("UPDATE match_deletion_audit SET reason='changed'").run(),/append-only/);
});

test("deleting an older rated match cannot erase later rating changes",async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});const {EloDB}=require("../lib/elo"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"delmatch-history-")),elo=new EloDB(path.join(dir,"test.db"));t.after(()=>{elo.db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const db=elo.db;db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY); INSERT INTO matches VALUES ('OLD'); INSERT INTO ratings VALUES ('player','Player',2040); INSERT INTO rating_changes (match_id,ts,player_id,before,after,delta) VALUES ('OLD',1,'player',2000,2020,20),('LATER',2,'player',2020,2040,20)");const s=createPredictions({db,config:{predictionsEnabled:true}});t.after(()=>s.stop());const reg=new Map(),sent=[];require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo,matchesStore:{},predictions:s});await reg.get("delmatch")({author:{id:"admin"},member:{roles:{cache:{has:()=>true}}},channel:{id:"pickup",send:async x=>sent.push(x)}},["OLD"]);
 assert.match(sent[0],/failed/i);assert.equal(db.prepare("SELECT rating FROM ratings WHERE player_id='player'").get().rating,2040);assert.equal(db.prepare("SELECT count(*) n FROM rating_changes").get().n,2);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);assert.equal(db.prepare("SELECT count(*) n FROM match_deletion_audit").get().n,0);
});

test("deletion refuses to overwrite an Elo rating changed outside the recorded history",async t=>{
 const old=process.env.ADMIN_ROLE_ID;process.env.ADMIN_ROLE_ID="admin";t.after(()=>{if(old==null)delete process.env.ADMIN_ROLE_ID;else process.env.ADMIN_ROLE_ID=old;});const {EloDB}=require("../lib/elo"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"delmatch-mismatch-")),elo=new EloDB(path.join(dir,"test.db"));t.after(()=>{elo.db.close();fs.rmSync(dir,{recursive:true,force:true});});const db=elo.db;db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY); INSERT INTO matches VALUES ('OLD'); INSERT INTO ratings VALUES ('player','Player',2050); INSERT INTO rating_changes (match_id,ts,player_id,before,after,delta) VALUES ('OLD',1,'player',2000,2020,20)");const s=createPredictions({db,config:{predictionsEnabled:true}});t.after(()=>s.stop());const reg=new Map(),sent=[];require("../commands/admin").register(reg,{config:{channels:{pickup:"pickup",eloAdmin:"admin"}},state:{matches:[]},elo,matchesStore:{},predictions:s});await reg.get("delmatch")({author:{id:"admin"},member:{roles:{cache:{has:()=>true}}},channel:{id:"pickup",send:async x=>sent.push(x)}},["OLD"]);assert.match(sent[0],/failed/i);assert.equal(db.prepare("SELECT rating FROM ratings").get().rating,2050);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);
});

test("legacy deletion paths still require owner authorization for settled history",t=>{
 const {s,db,m,remove}=setup(t);s.store.closeMarket(m.id,s.context("close"));s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context("settle")});assert.throws(()=>s.applyMatchDeletion({matchId:"DELETED",applyMatchWrites:remove}),/Owner must authorize/);assert.equal(db.prepare("SELECT count(*) n FROM matches").get().n,1);assert.equal(s.store.market(m.id).deletion_authorized,0);
});
