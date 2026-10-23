"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {PredictionStore}=require('../predictions/store');
let seq=0;const context=()=>({operationKey:`exact:${++seq}`,actorId:'owner',reason:'accounting regression',now:100});
function setup(t){const db=new Database(':memory:');t.after(()=>db.close());return new PredictionStore(db);}

test('aggregate accounting remains exact after two-point escrow above the safe global number range',t=>{
 const s=setup(t);
 for(const user of ['u','v','w'])s.adjust(user,Number.MAX_SAFE_INTEGER-1000,context());
 const m=s.createMarket({matchId:'EXACT',blueIds:['b1','b2','b3','b4'],redIds:['r1','r2','r3','r4'],offenseIds:[],serverKey:'east',mapName:'shutdown2'},context());
 s.placeBet({marketRef:{marketId:m.id,revision:1},discordId:'u',pick:'blue',stake:2,context:context()});
 assert.equal(s.account('u').balance,9007199254740989);assert.equal(s.bets(m.id)[0].stake,2);assert.equal(s.assertAccounting(),true);
 s.cancelBet({marketRef:{marketId:m.id,revision:1},discordId:'u',context:context()});assert.equal(s.assertAccounting(),true);
});

test('aggregate accounting does not overflow SQLite signed-64-bit sums',t=>{
 const s=setup(t);
 s.atomic(()=>{for(let n=0;n<1025;n++)s.adjust(`large:${n}`,Number.MAX_SAFE_INTEGER-1000,context());});
 assert.equal(s.assertAccounting(),true);
});

test('exact accounting still rejects mismatched issuance and individual account history',t=>{
 const s=setup(t);s.ensureAccount('u',context());s.ensureAccount('v',context());
 s.db.prepare('UPDATE prediction_accounts SET balance=balance+1 WHERE discord_id=?').run('u');assert.throws(()=>s.assertAccounting(),/invariant/i);
 s.db.prepare('UPDATE prediction_accounts SET balance=balance-1 WHERE discord_id=?').run('v');assert.throws(()=>s.assertAccounting(),/history/i);
});
