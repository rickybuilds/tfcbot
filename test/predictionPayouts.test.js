"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {calculatePayouts}=require("../predictions/payouts");
const teams={blueIds:["b1","b2","b3","b4"],redIds:["r1","r2","r3","r4"]};
test("correct stakes return first and remaining pot is split 70/25/5",()=>{
 const bets=[{discord_id:"u",pick:"blue",stake:250},{discord_id:"v",pick:"blue",stake:150},...Array.from({length:3},(_,i)=>({discord_id:`x${i}`,pick:"red",stake:200}))];
 const p=calculatePayouts({...teams,bets,outcome:"blue"});
 assert.deepEqual(p.pools,[420,150,30]);assert.equal(p.credits.u,513);assert.equal(p.credits.v,307);
 assert.equal(Object.values(p.credits).reduce((a,b)=>a+b,0),1000);
});
test("tie uses 90/10 and integer remainders conserve every small pot",()=>{
 for(let a=1;a<=25;a++)for(let b=1;b<=25;b++) {
  const p=calculatePayouts({...teams,bets:[{discord_id:"u",pick:"tie",stake:a},{discord_id:"v",pick:"red",stake:b}],outcome:"tie"});
  assert.equal(Object.values(p.credits).reduce((x,y)=>x+y,0),a+b);
  assert.ok(p.credits.u>=a);
 }
});
test("no correct bettors refund stakes and no bets issue no rewards",()=>{
 const p=calculatePayouts({...teams,bets:[{discord_id:"u",pick:"red",stake:250}],outcome:"blue"});
 assert.deepEqual(p.credits,{u:250});assert.deepEqual(calculatePayouts({...teams,bets:[],outcome:"tie"}).credits,{});
});
