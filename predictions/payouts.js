"use strict";
function allocate(total, recipients) {
  if (!recipients.length) return [];
  const sum = recipients.reduce((n,r) => n + BigInt(r.weight), 0n);
  const rows = recipients.map(r => ({ ...r, amount: Number(BigInt(total)*BigInt(r.weight)/sum), remainder: BigInt(total)*BigInt(r.weight)%sum }));
  let left = total - rows.reduce((n,r) => n+r.amount,0);
  const ranked = [...rows].sort((a,b) => a.remainder === b.remainder ? (a.order ?? 0)-(b.order ?? 0) || (String(a.id)<String(b.id)?-1:1) : a.remainder>b.remainder?-1:1);
  for (let i=0;i<left;i++) ranked[i].amount++;
  return rows;
}
function multipliers(odds) {
  if(!odds||![odds.blue,odds.red].every(n=>Number.isInteger(n)&&n>=0&&n<=100)||odds.blue+odds.red!==100)throw new Error("Invalid prediction odds");
  const value=p=>p===0?300:Math.max(125,Math.min(300,Math.floor((15000+p)/(2*p))));
  return {blue:value(odds.blue),red:value(odds.red),tie:200};
}
function calculatePayouts({bets,outcome,blueIds,redIds,eloOdds,ruleVersion=3}) {
  if (!["blue","red","tie"].includes(outcome)) throw new Error("Invalid outcome");
  const totalStaked=bets.reduce((n,b)=>n+b.stake,0);
  if (!Number.isSafeInteger(totalStaked)) throw new Error("Unsafe total stake");
  const correct=bets.filter(b=>b.pick===outcome), C=correct.reduce((n,b)=>n+b.stake,0);
  const credits={};
  const add=(id,n)=>{if(n){const value=(credits[id]||0)+n;if(!Number.isSafeInteger(value))throw new Error("Unsafe payout");credits[id]=value;}};
  if(ruleVersion>=4){
    const rates=multipliers(eloOdds),bettorCredits={},playerCredits={};
    for(const b of correct){const amount=BigInt(b.stake)*BigInt(rates[outcome])/100n;if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Unsafe payout");bettorCredits[b.discord_id]=Number(amount);add(b.discord_id,Number(amount));}
    for(const id of [...blueIds,...redIds]){const amount=outcome==="tie"?10:(outcome==="blue"?blueIds:redIds).includes(id)?20:5;playerCredits[id]=amount;add(id,amount);}
    const distributed=Object.values(credits).reduce((n,v)=>n+BigInt(v),0n),difference=distributed-BigInt(totalStaked);
    if(difference>BigInt(Number.MAX_SAFE_INTEGER)||difference< -BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Unsafe house amount");
    return {credits,bettorCredits,playerCredits,multipliers:rates,totalStaked,houseFunding:Number(difference>0n?difference:0n),houseTake:Number(difference<0n?-difference:0n)};
  }
  if (!C) {
    if(ruleVersion>=3)return {credits,pools:outcome==="tie"?[0,0]:[0,0,0],totalStaked,houseTake:totalStaked};
    for(const b of bets)add(b.discord_id,b.stake);
    return {credits,pools:[],totalStaked};
  }
  for(const b of correct)add(b.discord_id,b.stake);
  const weights=outcome==="tie"?[90,10]:[70,25,5];
  const pools=allocate(totalStaked-C,weights.map((weight,i)=>({id:i,order:i,weight}))).map(r=>r.amount);
  for(const r of allocate(pools[0],correct.map(b=>({id:b.discord_id,weight:b.stake}))))add(r.id,r.amount);
  const groups=outcome==="tie"?[[...blueIds,...redIds]]:outcome==="blue"?[blueIds,redIds]:[redIds,blueIds];
  groups.forEach((ids,i)=>{for(const r of allocate(pools[i+1],ids.map(id=>({id,weight:1}))))add(r.id,r.amount);});
  return {credits,pools,totalStaked};
}
module.exports={calculatePayouts,multipliers};
