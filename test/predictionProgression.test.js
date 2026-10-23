"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Database=require("better-sqlite3");
const {PredictionStore}=require("../predictions/store");
let sequence=0;
const ctx=()=>({operationKey:`progress:${++sequence}`,actorId:"owner",reason:"test",now:1000});
const snapshot=id=>({matchId:id,blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"],offenseIds:[],steamIdsByDiscordId:{},serverKey:"east",mapName:"shutdown2",team1Starts:"offense"});
function setup(t){const db=new Database(":memory:");t.after(()=>db.close());return new PredictionStore(db);}
function bet(s,m,stake=100,user="u"){return s.placeBet({marketRef:{marketId:m.id,revision:m.revision},discordId:user,pick:"blue",stake,context:ctx()});}
function complete(s,m,outcome="tie"){s.closeMarket(m.id,ctx());s.settleMarket({marketId:m.id,outcome,context:ctx()});}

test("new games start at 100 and only distinct settled games increase the limit, independent of outcome",t=>{
 const s=setup(t),m=s.createMarket(snapshot("FIRST"),ctx());assert.equal(m.rule_version,2);
 assert.deepEqual(s.bettingProgress("u"),{settledGames:0,limit:100});
 assert.throws(()=>bet(s,m,101),/100/);assert.equal(s.account("u"),undefined);
 bet(s,m,80);bet(s,m,100);assert.equal(s.bettingProgress("u").limit,100);
 s.cancelBet({marketRef:{marketId:m.id,revision:1},discordId:"u",context:ctx()});assert.equal(s.bettingProgress("u").limit,100);
 bet(s,m,100);complete(s,m);assert.deepEqual(s.bettingProgress("u"),{settledGames:1,limit:110});
 const n=s.createMarket(snapshot("SECOND"),ctx());bet(s,n,110);complete(s,n,"blue");
 assert.deepEqual(s.bettingProgress("u"),{settledGames:2,limit:120});
 s.settleMarket({marketId:n.id,outcome:"blue",context:ctx()});s.correctSettlement({marketId:n.id,outcome:"red",context:ctx()});
 s.markReview(n.id,"corrected result pending");assert.equal(s.bettingProgress("u").limit,120);
 const loss=s.createMarket(snapshot("LOSS"),ctx());bet(s,loss,50);
 s.placeBet({marketRef:{marketId:loss.id,revision:1},discordId:"v",pick:"red",stake:50,context:ctx()});complete(s,loss,"red");
 assert.equal(s.bettingProgress("u").limit,130);assert.equal(s.bettingProgress("v").limit,110);
 assert.ok(s.account("b1").balance>1000);assert.equal(s.bettingProgress("b1").limit,100);assert.equal(s.assertAccounting(),true);
});
test("cancelled, voided and refunded revisions cannot farm stake progression",t=>{
 const s=setup(t),m=s.createMarket(snapshot("SAME"),ctx());bet(s,m,100);
 s.voidMarket({marketId:m.id,context:ctx()});assert.equal(s.bettingProgress("u").limit,100);
 const n=s.createMarket(snapshot("SAME"),ctx());bet(s,n,100);complete(s,n);
 const cancelled=s.createMarket(snapshot("CANCELLED"),ctx());bet(s,cancelled,100);
 s.cancelBet({marketRef:{marketId:cancelled.id,revision:1},discordId:"u",context:ctx()});complete(s,cancelled);
 assert.deepEqual(s.bettingProgress("u"),{settledGames:1,limit:110});assert.equal(s.assertAccounting(),true);
});
test("progression exceeds the former 250 cap and revalidates edits and insufficient balances",t=>{
 const s=setup(t);for(let i=0;i<91;i++){const game=s.createMarket(snapshot(`HISTORY_${i}`),ctx());bet(s,game,1);complete(s,game);}
 assert.equal(s.bettingProgress("u").limit,1010);
 const m=s.createMarket(snapshot("LARGE"),ctx());assert.throws(()=>bet(s,m,1001),/funds/i);
 bet(s,m,500);assert.equal(s.account("u").balance,500);bet(s,m,1000);assert.equal(s.account("u").balance,0);
 assert.throws(()=>bet(s,m,1011),/1,010/);assert.equal(s.bets(m.id)[0].stake,1000);
 assert.throws(()=>bet(s,m,Number.MAX_SAFE_INTEGER+1),/Stake/);assert.equal(s.assertAccounting(),true);
});
test("prediction schema upgrade preserves old bets and immutable history, and keeps existing games on their original rules",t=>{
 const s=setup(t),db=s.db,m=s.createMarket(snapshot("OLD"),ctx());db.prepare("UPDATE prediction_markets SET rule_version=1 WHERE id=?").run(m.id);
 bet(s,s.market(m.id),250);db.pragma("user_version=42");db.exec("CREATE TABLE elo_sentinel(id INTEGER PRIMARY KEY,rating INTEGER); INSERT INTO elo_sentinel VALUES(1,1941)");
 const rows=db.prepare("SELECT * FROM prediction_bets").all();
 db.exec(`DROP TABLE prediction_bets;
 CREATE TABLE prediction_bets(id INTEGER PRIMARY KEY, market_id INTEGER NOT NULL, discord_id TEXT NOT NULL,
 pick TEXT NOT NULL CHECK(pick IN ('blue','red','tie')), stake INTEGER NOT NULL CHECK(typeof(stake)='integer' AND stake BETWEEN 1 AND 250),
 status TEXT NOT NULL CHECK(status IN ('active','cancelled','refunded','settled')),created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(market_id,discord_id));
 CREATE INDEX prediction_market_bets ON prediction_bets(market_id,status);
 UPDATE prediction_meta SET value='1' WHERE key='schema_version';`);
 for(const row of rows)db.prepare("INSERT INTO prediction_bets VALUES (@id,@market_id,@discord_id,@pick,@stake,@status,@created_at,@updated_at)").run(row);
 const before=db.prepare("SELECT * FROM prediction_transactions ORDER BY id").all(),upgraded=new PredictionStore(db);
 assert.equal(upgraded.metadata("schema_version"),"2");assert.deepEqual(upgraded.bets(m.id),rows);
 assert.deepEqual(db.prepare("SELECT * FROM prediction_transactions ORDER BY id").all(),before);
 assert.equal(db.pragma("user_version",{simple:true}),42);assert.equal(db.prepare("SELECT rating FROM elo_sentinel").get().rating,1941);
 bet(upgraded,upgraded.market(m.id),250);upgraded.voidMarket({marketId:m.id,context:ctx()});
 const reset=upgraded.createMarket(snapshot("OLD"),ctx());assert.equal(reset.rule_version,1);bet(upgraded,reset,250);complete(upgraded,reset);
 const next=upgraded.createMarket(snapshot("NEW"),ctx());assert.throws(()=>bet(upgraded,next,111),/110/);bet(upgraded,next,110);
 new PredictionStore(db);assert.equal(upgraded.bets(next.id)[0].stake,110);assert.equal(upgraded.assertAccounting(),true);
 assert.throws(()=>db.exec("UPDATE prediction_transactions SET amount=0"),/append-only/);
});
test("a failed prediction schema upgrade rolls back all changes and retains the original data",t=>{
 const db=new Database(":memory:");t.after(()=>db.close());
 db.exec(`CREATE TABLE prediction_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO prediction_meta VALUES('schema_version','1');
 CREATE TABLE prediction_bets(id INTEGER PRIMARY KEY,market_id INTEGER,discord_id TEXT,pick TEXT,stake INTEGER,status TEXT,created_at INTEGER,updated_at INTEGER,UNIQUE(market_id,discord_id));
 INSERT INTO prediction_bets VALUES(1,1,'u','blue',-1,'active',1000,1000);
 CREATE TABLE elo_sentinel(rating INTEGER); INSERT INTO elo_sentinel VALUES(1941);`);
 assert.throws(()=>new PredictionStore(db),/CHECK constraint/);
 assert.equal(db.prepare("SELECT value FROM prediction_meta WHERE key='schema_version'").get().value,"1");
 assert.equal(db.prepare("SELECT stake FROM prediction_bets WHERE id=1").get().stake,-1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('prediction_bets_v2','prediction_accounts')").get().n,0);
 assert.equal(db.prepare("SELECT rating FROM elo_sentinel").get().rating,1941);
});
