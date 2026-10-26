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
function calculatePayouts({bets,outcome,blueIds,redIds,ruleVersion=3}) {
  if (!["blue","red","tie"].includes(outcome)) throw new Error("Invalid outcome");
  const totalStaked=bets.reduce((n,b)=>n+b.stake,0);
  if (!Number.isSafeInteger(totalStaked)) throw new Error("Unsafe total stake");
  const correct=bets.filter(b=>b.pick===outcome), C=correct.reduce((n,b)=>n+b.stake,0);
  const credits={};
  const add=(id,n)=>{if(n)credits[id]=(credits[id]||0)+n;};
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
module.exports={calculatePayouts};
