"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){
 let now=1000;const db=new Database(":memory:");db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT,blue_ids TEXT,red_ids TEXT,map_name TEXT,server_name TEXT)");
 const snapshot={matchId:"RECON1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:Object.fromEntries(["b1","b2","b3","b4","r1","r2","r3","r4"].map((id,i)=>[id,[`STEAM_0:1:${i}`]])),serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};
 const s=createPredictions({db,config:{predictionsEnabled:true,predictionsOwnerId:"owner"},clock:()=>now,logger:{warn(){}},waitForRosterRetry:async()=>{},queryServerRoster:async()=>({complete:true,mapName:"shutdown2",steamIds:Object.values(snapshot.steamIdsByDiscordId).flat()})});
 s.refreshCard=async()=>{};const m=s.onMatchFinalized(snapshot);t.after(()=>{s.stop();db.close();});
 const row=(id="RECON1",status="in_progress",winner=null)=>db.prepare("INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?)").run(id,winner,status,JSON.stringify(snapshot.blueIds),JSON.stringify(snapshot.redIds),snapshot.mapName,snapshot.serverKey);
 row();const report=(winner="BLUE",id="RECON1")=>row(id,"completed",winner);
 const bet=(game=m,user="spectator",pick="blue")=>s.store.placeBet({marketRef:{marketId:game.id,revision:game.revision},discordId:user,pick,stake:100,context:s.context("bet",user)});
 const ready=()=>s.store.startCountdown(m.id,1000);
 return {s,db,m,snapshot,row,report,bet,ready,time:n=>{now=n;}};
}
test("periodic reconciliation settles a committed completed match after its immediate callback was missed",t=>{
 const {s,m,report,bet,ready,time}=setup(t);bet();ready();time(121000);s.tick();report();s.reconcileCompletedMatches();
 assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.market(m.id).result,"blue");assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.assertAccounting(),true);
});
test("one failed payout does not prevent other completed games settling and the failed game retries once",t=>{
 const {s,db,m,snapshot,report,bet,ready,time}=setup(t);bet();ready();const other=s.store.createMarket({...snapshot,matchId:"RECON2",serverKey:"east"},s.context("create"));bet(other,"other");s.store.startCountdown(other.id,1000);time(121000);s.tick();report();report("BLUE","RECON2");
 db.exec(`CREATE TRIGGER fail_first BEFORE INSERT ON prediction_transactions WHEN NEW.kind='settlement' AND NEW.market_id=${m.id} BEGIN SELECT RAISE(ABORT,'injected payout failure'); END`);
 s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"closed");assert.equal(s.store.market(other.id).state,"settled");assert.equal(s.store.account("spectator").balance,900);
 db.exec("DROP TRIGGER fail_first");s.reconcileCompletedMatches();s.reconcileCompletedMatches();assert.equal(s.store.account("spectator").balance,1000);assert.equal(s.store.account("other").balance,1000);assert.equal(s.store.market(m.id).settlement_version,1);
});
test("reconciliation detects a corrected DB winner after restart without granting unconfirmed correction credits",async t=>{
 const {s,db,m,report,bet,ready,time}=setup(t);bet();ready();time(121000);s.tick();report();s.onMatchReported({matchId:"RECON1"});report("RED");await s.initialize();
 assert.equal(s.store.market(m.id).state,"review_required");assert.equal(s.store.market(m.id).observed_result,"red");assert.equal(s.store.market(m.id).result,"blue");assert.equal(s.store.market(m.id).settlement_version,1);assert.equal(s.store.account("spectator").balance,1000);assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions WHERE kind='correction'").get().n,0);
});
for(const change of ["teams","map","server"]){test(`ordinary closed settlement validates official ${change} before crediting`,t=>{
 const {s,db,m,report,bet,ready,time}=setup(t);bet();ready();time(121000);s.tick();report();
 const sql={teams:"UPDATE matches SET blue_ids='[]'",map:"UPDATE matches SET map_name='other'",server:"UPDATE matches SET server_name='west'"};db.exec(sql[change]);s.onMatchReported({matchId:"RECON1"});
 assert.equal(s.store.market(m.id).state,"review_required");assert.equal(s.store.market(m.id).settlement_version,0);assert.equal(s.store.account("spectator").balance,900);
});}
test("restart preserves a verified future deadline and later completed-report settlement",async t=>{
 const {s,m,report,bet,ready,time}=setup(t);bet();ready();time(50000);await s.initialize();assert.equal(s.store.market(m.id).state,"countdown");assert.equal(s.store.market(m.id).closes_at,121000);
 time(121000);report();s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.market(m.id).closes_at,121000);assert.equal(s.store.account("spectator").balance,1000);
});
test("an older restart-review with a verified expired deadline recovers from the completed official report",t=>{
 const {s,m,report,bet,ready,time}=setup(t);bet();ready();s.store.markReview(m.id,"restart: connection/terms history requires owner review");time(121000);report();s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.account("spectator").balance,1000);
});
test("missing deadlines and results recorded before a future deadline remain owner-reviewed",t=>{
 const {s,m,report,bet,time}=setup(t);bet();report();s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"review_required");assert.equal(s.store.market(m.id).closes_at,null);assert.equal(s.store.account("spectator").balance,900);
 s.db.prepare("UPDATE prediction_markets SET state='countdown',reason=NULL,observed_result=NULL,closes_at=121000 WHERE id=?").run(m.id);time(50000);s.reconcileCompletedMatches();time(121000);s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).settlement_version,0);assert.equal(s.store.market(m.id).state,"review_required");
});
test("stable reconciliation is idempotent without appending duplicate ledger operations",t=>{
 const {s,db,report,bet,ready,time}=setup(t);bet();ready();time(121000);report();s.reconcileCompletedMatches();const before=db.prepare("SELECT COUNT(*) n FROM prediction_transactions").get().n;
 for(let i=0;i<5;i++)s.reconcileCompletedMatches();assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions").get().n,before);
});
test("a completed old prediction cannot reserve the server or stop the next pickup",t=>{
 const {s,m,snapshot,report}=setup(t);report();s.store.markReview(m.id,"server monitoring unavailable");const next=s.onMatchFinalized({...snapshot,matchId:"NEXT"});assert.equal(next.match_id,"NEXT");assert.equal(s.store.market(m.id).state,"review_required");
});
test("a rejected old live marker cannot turn the current pregame into a live-only refund",t=>{
 const {s,m,snapshot}=setup(t);s.onHldsEvent({type:"map",name:"shutdown2",serverKey:"east",logInstance:"current.log",sourceTime:"10/22/2026 - 10:10:00"});s.onHldsEvent({type:"prediction_live_start",serverKey:"east",logInstance:"old.log",sourceTime:"10/22/2026 - 09:00:00"});assert.equal(s.store.market(m.id).phase,"pregame");
 const updated=s.applyRosterChange({matchId:"RECON1",nextSnapshot:{...snapshot,blueIds:["new","b2","b3","b4"]},applyMatchWrites:()=>{}});assert.equal(updated.revision,2);assert.equal(updated.state,"open");
});
test("readiness refreshes a newly repaired Steam link, audits it and freezes the links once the deadline starts",async t=>{
 const {s,db,m,snapshot,time}=setup(t);db.exec("CREATE TABLE player_steam_ids(discord_id TEXT,steam_id TEXT)");const insert=db.prepare("INSERT INTO player_steam_ids VALUES (?,?)");for(const [id,steam] of Object.entries(snapshot.steamIdsByDiscordId))if(id!=="r4")insert.run(id,steam[0]);
 db.prepare("UPDATE prediction_markets SET snapshot=json_set(snapshot,'$.steamIdsByDiscordId.r4',json('[]')) WHERE id=?").run(m.id);await s.reconcileServer("east");assert.equal(s.store.market(m.id).closes_at,null);
 insert.run("r4",snapshot.steamIdsByDiscordId.r4[0]);time(16000);await s.reconcileServer("east");assert.equal(s.store.market(m.id).closes_at,136000);assert.deepEqual(s.store.market(m.id).snapshot.steamIdsByDiscordId.r4,snapshot.steamIdsByDiscordId.r4);
 assert.ok(db.prepare("SELECT 1 FROM prediction_transactions WHERE market_id=? AND kind='readiness_links'").get(m.id));insert.run("r4","STEAM_0:1:999");time(31000);await s.reconcileServer("east");assert.equal(s.store.market(m.id).closes_at,136000);assert.deepEqual(s.store.market(m.id).snapshot.steamIdsByDiscordId.r4,snapshot.steamIdsByDiscordId.r4);
});
test("refreshing Steam links never treats a shared ambiguous identity as all eight present",async t=>{
 const {s,db,m,snapshot}=setup(t);db.exec("CREATE TABLE player_steam_ids(discord_id TEXT,steam_id TEXT)");const insert=db.prepare("INSERT INTO player_steam_ids VALUES (?,?)");for(const [id,steam] of Object.entries(snapshot.steamIdsByDiscordId))insert.run(id,id==="r4"?snapshot.steamIdsByDiscordId.b1[0]:steam[0]);await s.reconcileServer("east");assert.equal(s.store.market(m.id).closes_at,null);
});
test("the recurring maintenance callback reconciles completed reports without a restart or report callback",async t=>{
 const {s,m,report,bet,ready,time}=setup(t);let heartbeat;t.mock.method(global,"setInterval",fn=>{heartbeat=fn;return {unref(){}};});s.pollRosters=async()=>{};bet();ready();time(50000);await s.initialize();time(121000);report();for(let i=0;i<15;i++)heartbeat();await Promise.resolve();assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.account("spectator").balance,1000);
});
test("background checks retain an explicitly accepted owner map change and allow its later audited correction",async t=>{
 const {s,db,m,report,bet,ready,time}=setup(t);bet();bet(m,"red-bettor","red");ready();time(121000);report();db.prepare("UPDATE matches SET map_name='openfire'").run();s.store.markReview(m.id,"unexpected server map");
 const messages=[];const message={id:"accept-map",author:{id:"owner",send:async p=>messages.push(p)}};
 await s.handleAdminCommand(message,["settle","RECON1","blue","--accept-map-change","Verified openfire and frozen bets"]);assert.ok(messages[0].components);
 const confirm=async p=>{const i={customId:p.components[0].components[0].data.custom_id,user:{id:"owner"},reply:async()=>{}};await s.handleInteraction(i);};await confirm(messages[0]);const before=db.prepare("SELECT COUNT(*) n FROM prediction_transactions").get().n;s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"settled");assert.equal(db.prepare("SELECT COUNT(*) n FROM prediction_transactions").get().n,before);
 db.prepare("UPDATE matches SET winner='RED'").run();s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"review_required");message.id="correct-map";await s.handleAdminCommand(message,["correct","RECON1","red","Correct official winner on the verified map"]);assert.ok(messages.at(-1).components);await confirm(messages.at(-1));s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"settled");assert.equal(s.store.market(m.id).result,"red");assert.equal(s.store.market(m.id).settlement_version,2);assert.equal(s.store.assertAccounting(),true);
});
test("card metadata failure is contained without rejecting the asynchronous card refresh",async t=>{
 const {s,db,m}=setup(t);s.store.db.prepare("UPDATE prediction_markets SET channel_id='pickup',message_id='card' WHERE id=?").run(m.id);db.exec("CREATE TRIGGER fail_card BEFORE INSERT ON prediction_meta WHEN NEW.key LIKE 'card_refresh:%' BEGIN SELECT RAISE(ABORT,'injected card metadata failure'); END");
 s.refreshCard=Object.getPrototypeOf(s).refreshCard.bind(s);await assert.doesNotReject(s.refreshCard(m.id));
});
test("an early committed report remains reviewed after callback failure and blocks any later bet mutations",t=>{
 const {s,db,m,report,bet,ready,time}=setup(t);bet();ready();time(50000);report();db.exec("ALTER TABLE matches ADD COLUMN processed_at INTEGER");db.prepare("UPDATE matches SET processed_at=50").run();
 const observe=s.observeOfficialResult.bind(s);s.observeOfficialResult=args=>{observe(args);throw new Error("injected observation failure");};assert.throws(()=>s.onMatchReported({matchId:"RECON1"}),/injected/);assert.equal(s.store.market(m.id).observed_result,null);
 time(60000);assert.throws(()=>bet(m,"late-winner"),/closed/i);assert.throws(()=>s.store.cancelBet({marketRef:{marketId:m.id,revision:1},discordId:"spectator",context:s.context("cancel","spectator")}),/closed/i);assert.equal(s.store.account("late-winner"),undefined);assert.equal(s.store.account("spectator").balance,900);
 s.observeOfficialResult=observe;time(125000);s.reconcileCompletedMatches();assert.equal(s.store.market(m.id).state,"review_required");assert.match(s.store.market(m.id).reason,/before betting deadline/);assert.equal(s.store.market(m.id).settlement_version,0);
});