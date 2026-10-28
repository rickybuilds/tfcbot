"use strict";
const crypto=require("node:crypto");
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
class PointGames {
 constructor(store,{randomInt=crypto.randomInt,cooldownMs=120000,maxStake=100}={}){
  if(!Number.isSafeInteger(cooldownMs)||cooldownMs<0||!Number.isSafeInteger(maxStake)||maxStake<1)throw new Error("Invalid games configuration");
  this.store=store;this.randomInt=randomInt;this.cooldownMs=cooldownMs;this.maxStake=maxStake;
  store.db.exec(`CREATE TABLE IF NOT EXISTS point_game_cooldowns (guild_id TEXT PRIMARY KEY, played_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS point_game_duels (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,challenger TEXT NOT NULL,opponent TEXT NOT NULL,stake INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);`);
 }
 stake(n){if(!Number.isSafeInteger(n)||n<1||n>this.maxStake)throw new Error(`Stake must be a whole number from 1 to ${this.maxStake}`);}
 checkPause(){if(this.store.metadata('paused','0')==='1')throw new Error('Point games are paused');}
 give({userId,recipientId,points,context:ctx}){
  if(!Number.isSafeInteger(points)||points<1)throw new Error('Points must be a positive whole number');
  if(String(userId)===String(recipientId))throw new Error('Choose another player');
  return this.store.operation(ctx,`give:${userId}:${recipientId}:${points}`,()=>{
   this.store.change(userId,-points,ctx,{kind:'gift_sent',entryKey:'gift-sent',metadata:{recipientId:String(recipientId)}});
   this.store.change(recipientId,points,ctx,{kind:'gift_received',entryKey:'gift-received',metadata:{senderId:String(userId)}});
   return {senderId:String(userId),recipientId:String(recipientId),points};
  });
 }
 play(user,stake,returned,ctx,game,metadata){
  this.store.change(user,-stake,ctx,{kind:"game_stake",entryKey:"stake",metadata:{game,...metadata}});
  if(returned)this.store.change(user,returned,ctx,{kind:"game_payout",entryKey:"payout",metadata:{game,...metadata}});
  const diff=returned-stake;
  if(diff>0)this.store.entry(ctx,{kind:"house_funding",amount:diff,entryKey:"house",metadata:{game}});
  if(diff<0)this.store.entry(ctx,{kind:"house_collection",amount:-diff,entryKey:"house",metadata:{game}});
 }
 roulette({guildId,userId,pick,stake,context:ctx}){
  pick=String(pick).toLowerCase();this.stake(stake);
  const numberPick=/^(?:0|[1-9]|[12][0-9]|3[0-6])$/.test(pick);
  if(!numberPick&&!['red','black','odd','even','low','high'].includes(pick))throw new Error("Choose red, black, odd, even, low, high, or a number from 0 to 36");
  return this.store.operation(ctx,`roulette:${guildId}:${userId}:${pick}:${stake}`,()=>{
   this.checkPause();
   const row=this.store.db.prepare("SELECT played_at FROM point_game_cooldowns WHERE guild_id=?").get(String(guildId));
   if(row&&ctx.now<row.played_at+this.cooldownMs)throw new Error(`Roulette cooldown: try again in ${Math.ceil((row.played_at+this.cooldownMs-ctx.now)/1000)} seconds`);
   const number=this.randomInt(37),color=number===0?'green':RED.has(number)?'red':'black';
   const won=numberPick?number===Number(pick):number!==0&&(pick===color||(pick==='odd'&&number%2===1)||(pick==='even'&&number%2===0)||(pick==='low'&&number<=18)||(pick==='high'&&number>=19));
   const returned=won?stake*(numberPick?36:2):0;
   this.play(userId,stake,returned,ctx,'roulette',{pick,number,color});
   this.store.db.prepare("INSERT INTO point_game_cooldowns VALUES (?,?) ON CONFLICT(guild_id) DO UPDATE SET played_at=excluded.played_at").run(String(guildId),ctx.now);
   return {number,color,pick,stake,returned};
  });
 }
 coinflip({userId,pick,stake,context:ctx}){
  pick=String(pick).toLowerCase();this.stake(stake);if(!['heads','tails'].includes(pick))throw new Error('Choose heads or tails');
  return this.store.operation(ctx,`coinflip:${userId}:${pick}:${stake}`,()=>{
   this.checkPause();
   const landed=this.randomInt(2)?'tails':'heads',returned=landed===pick?stake*2:0;
   this.play(userId,stake,returned,ctx,'coinflip',{pick,landed});return {landed,pick,stake,returned};
  });
 }
 challenge({guildId,userId,opponentId,stake,context:ctx}){
  this.stake(stake);if(String(userId)===String(opponentId))throw new Error('Choose another player');
  return this.store.operation(ctx,`duel-challenge:${guildId}:${userId}:${opponentId}:${stake}`,()=>{
   this.checkPause();
   if(this.store.ensureAccount(userId,ctx).balance<stake)throw new Error('Insufficient funds');
   this.store.db.prepare("INSERT INTO point_game_duels VALUES (?,?,?,?,?,?,'pending')").run(ctx.operationKey,String(guildId),String(userId),String(opponentId),stake,ctx.now+120000);
   return {id:ctx.operationKey,expiresAt:ctx.now+120000};
  });
 }
 accept({guildId,userId,challengeId,context:ctx}){
  return this.store.operation(ctx,`duel-accept:${guildId}:${userId}:${challengeId}`,()=>{
   this.checkPause();
   const d=this.store.db.prepare('SELECT * FROM point_game_duels WHERE id=?').get(challengeId);
   if(!d||d.guild_id!==String(guildId)||d.status!=='pending'||ctx.now>=d.expires_at)throw new Error('Duel is no longer pending');
   if(d.opponent!==String(userId))throw new Error('Only the challenged opponent can accept');
   const winner=this.randomInt(2)?d.opponent:d.challenger,loser=winner===d.challenger?d.opponent:d.challenger;
   // Both players must still be able to cover their wager when accepted.
   if(this.store.ensureAccount(winner,ctx).balance<d.stake||this.store.ensureAccount(loser,ctx).balance<d.stake)throw new Error('Both players need enough available points');
   this.store.change(loser,-d.stake,ctx,{kind:'duel_loss',entryKey:'loss',metadata:{challengeId}});
   this.store.change(winner,d.stake,ctx,{kind:'duel_win',entryKey:'win',metadata:{challengeId}});
   this.store.db.prepare("UPDATE point_game_duels SET status='settled' WHERE id=?").run(challengeId);
   return {winner,loser,stake:d.stake};
  });
 }
}
module.exports={PointGames};
