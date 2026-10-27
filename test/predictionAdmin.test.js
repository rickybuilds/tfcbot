"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {createPredictions}=require("../predictions");
function setup(t){let now=1000;const db=new Database(":memory:");t.after(()=>db.close());const s=createPredictions({db,config:{predictionsEnabled:true,predictionsOwnerId:"owner"},clock:()=>now});const m=s.onMatchFinalized({matchId:"MATCH1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});const privateMessages=[],publicMessages=[];const message={id:"command",author:{id:"owner",send:async p=>privateMessages.push(p)},channel:{send:async p=>publicMessages.push(p)}};return {s,db,m,message,privateMessages,publicMessages,time:n=>now=n};}
function confirmation(payload,id="confirm",user="owner") {const customId=payload.components[0].components[0].data.custom_id;return {id,customId,user:{id:user},reply:async function(p){this.response=p;}};}
test("unresolved privately lists every unfinished game and locked stake without changing finances",async t=>{
 const {s,m,message,privateMessages,publicMessages}=setup(t);
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});
 for(const [id,state] of [["TIMER","countdown"],["WAITING","closed"],["REVIEW","review_required"],["DONE","settled"],["VOID","void"]]){
  const game=s.store.createMarket({...m.snapshot,matchId:id},s.context("create"));
  s.db.prepare("UPDATE prediction_markets SET state=?,closes_at=?,reason=? WHERE id=?").run(state,state==="countdown"?121000:null,state==="review_required"?"server monitoring unavailable":null,game.id);
 }
 const before=s.db.prepare("SELECT COUNT(*) AS n FROM prediction_transactions").get().n;
 s.config.predictionsEnabled=false;await s.handleAdminCommand(message,["unresolved"]);
 const output=privateMessages[0].content;
 assert.match(output,/Unresolved prediction games \(4\)/);for(const id of ["MATCH1","TIMER","WAITING","REVIEW"])assert.match(output,new RegExp(id));
 assert.doesNotMatch(output,/DONE|VOID/);assert.match(output,/100 points locked/);assert.match(output,/server monitoring unavailable/);assert.match(output,/<t:121:F>/);
 assert.equal(publicMessages.length,0);assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM prediction_transactions").get().n,before);assert.equal(s.store.account("u").balance,900);
});
test("unresolved handles empty and long private lists and refuses nonowners without leaking game IDs",async t=>{
 const {s,m,message,privateMessages,publicMessages}=setup(t);
 message.author.id="admin";await s.handleAdminCommand(message,["unresolved"]);assert.match(privateMessages.pop().content,/owner/i);assert.equal(privateMessages.length,0);
 message.author.id="owner";s.store.voidMarket({marketId:m.id,context:s.context("void")});await s.handleAdminCommand(message,["unresolved"]);assert.equal(privateMessages.pop().content,"No unresolved prediction games.");
 for(let i=0;i<40;i++)s.store.createMarket({...m.snapshot,matchId:`LONG_GAME_${i}`},s.context("create"));
 await s.handleAdminCommand(message,["unresolved"]);const payload=privateMessages.pop();assert.ok(payload.content.length<2000);assert.equal(payload.files[0].name,"unresolved-predictions.txt");assert.match(payload.files[0].attachment.toString(),/LONG_GAME_39/);
 message.author.send=async()=>{throw new Error("DM blocked");};await s.handleAdminCommand(message,["unresolved"]);assert.equal(publicMessages.length,0);
});
test("financial controls require the configured owner; admin permission is insufficient",async t=>{
 const {s,message,privateMessages,publicMessages}=setup(t);message.author.id="admin";await s.handleAdminCommand(message,["adjust","u","100","test"]);assert.equal(s.store.account("u"),undefined);assert.equal(publicMessages.length,0);assert.match(privateMessages[0].content,/owner/i);
});
test("private confirmed adjustment is idempotent and confirmation is owner-bound",async t=>{
 const {s,message,privateMessages,publicMessages}=setup(t);await s.handleAdminCommand(message,["adjust","u","100","test"]);assert.equal(s.store.account("u"),undefined);
 const wrong=confirmation(privateMessages[0],"wrong","admin");await s.handleInteraction(wrong);assert.equal(s.store.account("u"),undefined);
 const i=confirmation(privateMessages[0]);await s.handleInteraction(i);assert.equal(s.store.account("u").balance,1100);
 await s.handleInteraction(confirmation(privateMessages[0]));assert.equal(s.store.account("u").balance,1100);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
});
test("expired and stale previews cannot mutate finances, and DM failure never leaks publicly",async t=>{
 const {s,message,privateMessages,publicMessages,time}=setup(t);await s.handleAdminCommand(message,["void","MATCH1","test"]);
 time(61000);const i=confirmation(privateMessages[0]);await s.handleInteraction(i);assert.match(i.response.content,/expired/i);assert.equal(s.store.latest("MATCH1").state,"open");
 message.id="other";message.author.send=async()=>{throw new Error("DM blocked");};await s.handleAdminCommand(message,["audit","MATCH1"]);assert.equal(publicMessages.length,0);
});
test("result correction requires official outcome and funds all extra credits through house issuance",async t=>{
 const {s,db,m,message,privateMessages}=setup(t);db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT,blue_ids TEXT,red_ids TEXT,map_name TEXT,server_name TEXT)");db.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?,?)").run("MATCH1","RED","in_progress",JSON.stringify(m.snapshot.blueIds),JSON.stringify(m.snapshot.redIds),m.snapshot.mapName,"TFC East US Server");
 s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"u",pick:"blue",stake:100,context:s.context("bet","u")});s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:"v",pick:"red",stake:100,context:s.context("bet","v")});db.prepare("UPDATE matches SET status='completed'").run();s.store.closeMarket(m.id,s.context());s.store.settleMarket({marketId:m.id,outcome:"blue",context:s.context()});
 await s.handleAdminCommand(message,["correct","MATCH1","blue","wrong"]);assert.match(privateMessages[0].content,/official/i);
 message.id="correct";await s.handleAdminCommand(message,["correct","MATCH1","red","official correction"]);await s.handleInteraction(confirmation(privateMessages[1]));assert.equal(s.store.account("u").balance,1050);assert.equal(s.store.account("v").balance,1050);assert.ok(s.store.houseFunding()>0);assert.equal(s.store.assertAccounting(),true);
});


function completedCorrection(t){
 const f=setup(t),{s,db,m}=f;
 db.exec('CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,status TEXT,blue_ids TEXT,red_ids TEXT,map_name TEXT,server_name TEXT)');
 db.prepare('INSERT INTO matches VALUES (?,?,?,?,?,?,?)').run('MATCH1','RED','in_progress',JSON.stringify(m.snapshot.blueIds),JSON.stringify(m.snapshot.redIds),m.snapshot.mapName,'TFC East US Server');
 for(const [user,pick] of [['u','blue'],['v','red']])s.store.placeBet({marketRef:{marketId:m.id,revision:1},discordId:user,pick,stake:100,context:s.context('bet',user)});
 db.prepare("UPDATE matches SET status='completed'").run();s.store.closeMarket(m.id,s.context());s.store.settleMarket({marketId:m.id,outcome:'blue',context:s.context()});
 s.store.markReview(m.id,'official terms conflict');return f;
}

test('owner corrections cannot clear frozen roster, map or server conflicts using only the official winner',async t=>{
 const {s,db,message,privateMessages,publicMessages}=completedCorrection(t);
 for(const [column,value] of [['blue_ids','["b1","b2","b3","other"]'],['map_name','different_map'],['server_name','TFC West US Server']]){
  const original=db.prepare(`SELECT ${column} AS value FROM matches`).get().value;
  db.prepare(`UPDATE matches SET ${column}=?`).run(value);message.id=`reject:${column}`;
  await s.handleAdminCommand(message,['correct','MATCH1','red','verified official winner']);
  assert.equal(privateMessages.at(-1).components,undefined);assert.match(privateMessages.at(-1).content,/teams|map|server/i);
  db.prepare(`UPDATE matches SET ${column}=?`).run(original);
 }
 assert.equal(s.store.latest('MATCH1').state,'review_required');assert.equal(s.store.latest('MATCH1').settlement_version,1);assert.equal(s.store.account('v').balance,900);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
});

test('correction confirmation rejects changed official terms and settled bet inputs privately',async t=>{
 const {s,db,message,privateMessages,publicMessages}=completedCorrection(t);
 for(const [name,mutate,restore] of [
  ['server',()=>db.prepare("UPDATE matches SET server_name='TFC West US Server'").run(),()=>db.prepare("UPDATE matches SET server_name='TFC East US Server'").run()],
  ['bets',()=>db.prepare("UPDATE prediction_bets SET pick='red' WHERE discord_id='u'").run(),()=>db.prepare("UPDATE prediction_bets SET pick='blue' WHERE discord_id='u'").run()]
 ]){
  message.id=`preview:${name}`;await s.handleAdminCommand(message,['correct','MATCH1','red','verified official correction']);const p=privateMessages.at(-1);assert.ok(p.components);mutate();
  const i=confirmation(p,`confirm:${name}`);await s.handleInteraction(i);assert.match(i.response.content,/changed/i);restore();
 }
 assert.equal(s.store.latest('MATCH1').settlement_version,1);assert.equal(s.store.account('v').balance,900);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
});

test('repeated owner corrections pay only extra entitlements and stay private',async t=>{
 const {s,db,message,privateMessages,publicMessages}=completedCorrection(t);
 for(const [index,outcome] of ['red','blue','red'].entries()){
  db.prepare('UPDATE matches SET winner=?').run(outcome.toUpperCase());message.id=`correction:${index}`;
  await s.handleAdminCommand(message,['correct','MATCH1',outcome,'verified official correction']);const p=privateMessages.at(-1);assert.ok(p.components);
  await s.handleInteraction(confirmation(p,`correct:${index}`));await s.handleInteraction(confirmation(p,`repeat:${index}`));
 }
 assert.equal(s.store.account('u').balance,1050);assert.equal(s.store.account('v').balance,1050);assert.equal(s.store.houseFunding(),260);assert.equal(publicMessages.length,0);assert.equal(s.store.assertAccounting(),true);
});
