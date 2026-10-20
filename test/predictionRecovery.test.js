"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),zlib=require("node:zlib");
const {PredictionStore}=require("../predictions/store");
let n=0;const ctx=()=>({operationKey:`test:${++n}`,actorId:"owner",reason:"test",now:1000});
const snapshot={matchId:"MATCH1",blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"};
function place(s,m,user="u"){return s.placeBet({marketRef:{marketId:m.id,revision:1},discordId:user,pick:"blue",stake:250,context:ctx()});}
test("two handles serialize grants/spending and history cannot be edited or deleted",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"prediction-contention-")),file=path.join(dir,"elo.db"),a=new Database(file),b=new Database(file);
 t.after(()=>{a.close();b.close();fs.rmSync(dir,{recursive:true,force:true});});
 a.pragma("journal_mode=WAL");b.pragma("busy_timeout=1");a.pragma("user_version=42");const s=new PredictionStore(a),other=new PredictionStore(b),m=s.createMarket(snapshot,ctx());
 s.ensureAccount("u",ctx());other.ensureAccount("u",ctx());assert.equal(s.account("u").balance,1000);assert.equal(a.pragma("user_version",{simple:true}),42);
 a.exec("BEGIN IMMEDIATE");assert.throws(()=>place(other,m),/locked/);a.exec("ROLLBACK");place(other,m);
 assert.equal(s.account("u").balance,750);assert.equal(s.bets(m.id).length,1);assert.equal(s.assertAccounting(),true);
 assert.throws(()=>a.exec("DELETE FROM prediction_transactions"),/append-only/);assert.throws(()=>a.exec("UPDATE prediction_transactions SET amount=0"),/append-only/);
});
test("SQLite backup restores WAL escrow, original deadline and settlement idempotency",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"prediction-restore-")),file=path.join(dir,"custom-elo.db"),db=new Database(file);let restored;
 t.after(()=>{restored?.close();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.pragma("journal_mode=WAL");db.pragma("wal_autocheckpoint=0");const s=new PredictionStore(db),m=s.createMarket(snapshot,ctx());place(s,m);s.startCountdown(m.id,1000);
 const backup=require("../lib/backup").scheduleBackups({getBool:()=>false},{sources:[file],destDir:path.join(dir,"backup")});assert.equal((await backup.runNow())[0].ok,true);
 const archived=fs.readdirSync(path.join(dir,"backup"))[0],restoreFile=path.join(dir,"restored.db");fs.writeFileSync(restoreFile,zlib.gunzipSync(fs.readFileSync(path.join(dir,"backup",archived))));
 restored=new Database(restoreFile);const r=new PredictionStore(restored);assert.equal(r.account("u").balance,750);assert.equal(r.market(m.id).closes_at,121000);assert.equal(r.assertAccounting(),true);
 r.closeMarket(m.id,ctx());r.settleMarket({marketId:m.id,outcome:"blue",context:ctx()});r.settleMarket({marketId:m.id,outcome:"blue",context:ctx()});r.ensureAccount("u",ctx());assert.equal(r.account("u").balance,1000);assert.equal(r.assertAccounting(),true);
});
