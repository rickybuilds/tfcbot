"use strict";
const crypto=require("node:crypto");
const RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
class PointGames {
 constructor(store,{randomInt=crypto.randomInt,maxStake=100}={}){
  if(!Number.isSafeInteger(maxStake)||maxStake<1)throw new Error("Invalid games configuration");
  this.store=store;this.randomInt=randomInt;this.maxStake=maxStake;
  store.db.exec(`CREATE TABLE IF NOT EXISTS point_game_duels (id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,challenger TEXT NOT NULL,opponent TEXT NOT NULL,stake INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL);`);
 }
 stake(n){if(!Number.isSafeInteger(n)||n<1||n>this.maxStake)throw new Error(`Stake must be a whole number from 1 to ${this.maxStake}`);}
 checkPause(){if(this.store.metadata('paused','0')==='1')throw new Error('Point games are paused');}
 crapsStatus({guildId,channelId}){return this.store.db.prepare("SELECT * FROM point_craps_rounds WHERE guild_id=? AND channel_id=? AND state IN ('open','point')").get(String(guildId),String(channelId));}
 crapsPlace({guildId,channelId,userId,number,stake,context:ctx}){
  number=Number(number);this.stake(stake);if(![4,5,6,8,9,10].includes(number))throw new Error('Choose a place number: 4, 5, 6, 8, 9, or 10');
  return this.store.operation(ctx,`craps-place:${guildId}:${channelId}:${userId}:${number}:${stake}`,()=>{
   this.checkPause();const round=this.crapsStatus({guildId,channelId});if(!round||round.state!=='point')throw new Error('Craps place bets require an established point');
   const old=this.store.db.prepare('SELECT status FROM point_craps_places WHERE round_id=? AND user_id=? AND number=?').get(round.id,String(userId),number);
   if(old?.status==='active')throw new Error('Craps place bet already exists on that number');
   this.store.change(userId,-stake,ctx,{kind:'game_stake',entryKey:'stake',metadata:{game:'craps',roundId:round.id,number}});
   this.store.db.prepare("INSERT INTO point_craps_places VALUES (?,?,?,?,'active') ON CONFLICT(round_id,user_id,number) DO UPDATE SET stake=excluded.stake,status='active'").run(round.id,String(userId),number,stake);
   return {roundId:round.id,number,stake};
  });
 }
 crapsTake({guildId,channelId,userId,number,context:ctx}){
  number=Number(number);if(![4,5,6,8,9,10].includes(number))throw new Error('Choose a place number: 4, 5, 6, 8, 9, or 10');
  return this.store.operation(ctx,`craps-take:${guildId}:${channelId}:${userId}:${number}`,()=>{
   const round=this.crapsStatus({guildId,channelId});const bet=round&&this.store.db.prepare("SELECT * FROM point_craps_places WHERE round_id=? AND user_id=? AND number=? AND status='active'").get(round.id,String(userId),number);
   if(!bet)throw new Error('Craps place bet not found');
   this.store.change(userId,bet.stake,ctx,{kind:'game_payout',entryKey:'refund',metadata:{game:'craps',roundId:round.id,number,refund:true}});
   this.store.db.prepare("UPDATE point_craps_places SET status='refunded' WHERE round_id=? AND user_id=? AND number=?").run(round.id,String(userId),number);
   return {number,stake:bet.stake};
  });
 }
 crapsJoin({guildId,channelId,userId,pick,stake,context:ctx}){
  pick=String(pick).toLowerCase();this.stake(stake);if(!['pass','dont'].includes(pick))throw new Error('Choose pass or dont');
  return this.store.operation(ctx,`craps-join:${guildId}:${channelId}:${userId}:${pick}:${stake}`,()=>{
   this.checkPause();let round=this.crapsStatus({guildId,channelId});
   if(round?.state==='point')throw new Error('Craps betting is closed until the next round');
   if(!round){const id=this.store.db.prepare("INSERT INTO point_craps_rounds (guild_id,channel_id,shooter,state,updated_at) VALUES (?,?,?,'open',?)").run(String(guildId),String(channelId),String(userId),ctx.now).lastInsertRowid;round=this.store.db.prepare('SELECT * FROM point_craps_rounds WHERE id=?').get(id);}
   if(this.store.db.prepare('SELECT 1 FROM point_craps_bets WHERE round_id=? AND user_id=?').get(round.id,String(userId)))throw new Error('Choose one bet per craps round');
   this.store.change(userId,-stake,ctx,{kind:'game_stake',entryKey:'stake',metadata:{game:'craps',roundId:round.id,pick}});
   this.store.db.prepare("INSERT INTO point_craps_bets VALUES (?,?,?,?,'active')").run(round.id,String(userId),pick,stake);return round;
  });
 }
 crapsCancel({guildId,channelId,userId,context:ctx}){
  return this.store.operation(ctx,`craps-cancel:${guildId}:${channelId}:${userId}`,()=>{
   const round=this.crapsStatus({guildId,channelId});if(!round)throw new Error('Craps table has no active round');
   if(round.shooter!==String(userId))throw new Error('Only the shooter can cancel');
   if(round.state!=='open')throw new Error('Craps can only be cancelled before the first roll');
   for(const b of this.store.db.prepare("SELECT * FROM point_craps_bets WHERE round_id=? AND status='active'").all(round.id))this.store.change(b.user_id,b.stake,ctx,{kind:'game_payout',entryKey:`refund:${b.user_id}`,metadata:{game:'craps',roundId:round.id,refund:true}});
   for(const b of this.store.db.prepare("SELECT * FROM point_craps_places WHERE round_id=? AND status='active'").all(round.id))this.store.change(b.user_id,b.stake,ctx,{kind:'game_payout',entryKey:`place-refund:${b.user_id}:${b.number}`,metadata:{game:'craps',roundId:round.id,number:b.number,refund:true}});
   this.store.db.prepare("UPDATE point_craps_bets SET status='refunded' WHERE round_id=? AND status='active'").run(round.id);
   this.store.db.prepare("UPDATE point_craps_places SET status='refunded' WHERE round_id=? AND status='active'").run(round.id);
   this.store.db.prepare("UPDATE point_craps_rounds SET state='cancelled',updated_at=? WHERE id=?").run(ctx.now,round.id);return {id:round.id};
  });
 }
 crapsRoll({roundId,guildId,channelId,userId,context:ctx}){
  return this.store.operation(ctx,`craps-roll:${roundId}:${guildId}:${channelId}:${userId}`,()=>{
   const round=this.crapsStatus({guildId,channelId});if(!round||round.id!==Number(roundId))throw new Error('Craps table is no longer active');
   if(round.shooter!==String(userId)){
    const bettor=this.store.db.prepare("SELECT 1 FROM point_craps_bets WHERE round_id=? AND user_id=? AND status='active' UNION ALL SELECT 1 FROM point_craps_places WHERE round_id=? AND user_id=? AND status='active' LIMIT 1").get(round.id,String(userId),round.id,String(userId));
    if(!bettor||ctx.now-round.updated_at<600000)throw new Error('Only the shooter can roll until the table is idle for 10 minutes');
   }
   const dice=[this.randomInt(6)+1,this.randomInt(6)+1],sum=dice[0]+dice[1];let outcome=null,point=round.point;
   if(round.state==='open'){
    if(sum===7||sum===11)outcome='pass';else if(sum===2||sum===3)outcome='dont';else if(sum===12)outcome='push';else point=sum;
   }else if(sum===point)outcome='pass';else if(sum===7)outcome='dont';
   const placePayouts=[];
   if(round.state==='point'){
    for(const b of this.store.db.prepare("SELECT * FROM point_craps_places WHERE round_id=? AND status='active'").all(round.id)){
     if(sum===7){this.store.entry(ctx,{kind:'house_collection',amount:b.stake,entryKey:`place-loss:${b.user_id}:${b.number}`,metadata:{game:'craps',roundId:round.id,number:b.number}});}
     else if(sum===b.number){const numerator=b.number===4||b.number===10?9:7,denominator=b.number===6||b.number===8?6:5,profit=Math.floor(b.stake*numerator/denominator);
      if(profit){this.store.change(b.user_id,profit,ctx,{kind:'game_payout',entryKey:`place-profit:${b.user_id}:${b.number}`,metadata:{game:'craps',roundId:round.id,number:b.number}});this.store.entry(ctx,{kind:'house_funding',amount:profit,entryKey:`place-funding:${b.user_id}:${b.number}`,metadata:{game:'craps',roundId:round.id,number:b.number}});}
      placePayouts.push({userId:b.user_id,number:b.number,profit});
     }
    }
    if(sum===7)this.store.db.prepare("UPDATE point_craps_places SET status='lost' WHERE round_id=? AND status='active'").run(round.id);
   }
   if(outcome){
    for(const b of this.store.db.prepare("SELECT * FROM point_craps_bets WHERE round_id=? AND status='active'").all(round.id)){
     const returned=outcome==='push'&&b.pick==='dont'?b.stake:b.pick===outcome?b.stake*2:0;
     if(returned)this.store.change(b.user_id,returned,ctx,{kind:'game_payout',entryKey:`payout:${b.user_id}`,metadata:{game:'craps',roundId:round.id,outcome}});
     const diff=returned-b.stake;if(diff)this.store.entry(ctx,{kind:diff>0?'house_funding':'house_collection',amount:Math.abs(diff),entryKey:`house:${b.user_id}`,metadata:{game:'craps',roundId:round.id}});
    }
    this.store.db.prepare("UPDATE point_craps_bets SET status='settled' WHERE round_id=? AND status='active'").run(round.id);
   }
   const state=outcome?'settled':'point';this.store.db.prepare('UPDATE point_craps_rounds SET state=?,point=?,shooter=?,updated_at=? WHERE id=?').run(state,point,String(userId),ctx.now,round.id);
   let nextRoundId=null;
   if(outcome&&this.store.db.prepare("SELECT 1 FROM point_craps_places WHERE round_id=? AND status='active' LIMIT 1").get(round.id)){
    nextRoundId=Number(this.store.db.prepare("INSERT INTO point_craps_rounds(guild_id,channel_id,shooter,state,updated_at) VALUES (?,?,?,'open',?)").run(String(guildId),String(channelId),String(userId),ctx.now).lastInsertRowid);
    this.store.db.prepare("UPDATE point_craps_places SET round_id=? WHERE round_id=? AND status='active'").run(nextRoundId,round.id);
   }
   return {id:round.id,dice,sum,point,state,outcome,shooter:String(userId),placePayouts,nextRoundId};
  });
 }
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
   const number=this.randomInt(37),color=number===0?'green':RED.has(number)?'red':'black';
   const won=numberPick?number===Number(pick):number!==0&&(pick===color||(pick==='odd'&&number%2===1)||(pick==='even'&&number%2===0)||(pick==='low'&&number<=18)||(pick==='high'&&number>=19));
   const returned=won?stake*(numberPick?36:2):0;
   this.play(userId,stake,returned,ctx,'roulette',{pick,number,color});
   return {number,color,pick,stake,returned};
  });
 }
 baccarat({userId,pick,stake,context:ctx}){
  pick=String(pick).toLowerCase();this.stake(stake);
  if(!['player','banker','tie'].includes(pick))throw new Error('Choose player, banker, or tie');
  return this.store.operation(ctx,`baccarat:${userId}:${pick}:${stake}`,()=>{
   this.checkPause();
   const shoe=Array.from({length:416},(_,i)=>Math.floor(i/32)+1);
   const draw=()=>shoe.splice(this.randomInt(shoe.length),1)[0];
   const value=card=>card>=10?0:card;
   const total=cards=>cards.reduce((sum,card)=>sum+value(card),0)%10;
   const player=[draw()],banker=[draw()];player.push(draw());banker.push(draw());
   const p=total(player),b=total(banker);
   if(p<8&&b<8){
    if(p<=5)player.push(draw());
    const third=player.length===3?value(player[2]):null;
    const bankerDraw=third===null?b<=5:b<=2||(b===3&&third!==8)||(b===4&&third>=2&&third<=7)||(b===5&&third>=4&&third<=7)||(b===6&&(third===6||third===7));
    if(bankerDraw)banker.push(draw());
   }
   const playerTotal=total(player),bankerTotal=total(banker),outcome=playerTotal===bankerTotal?'tie':playerTotal>bankerTotal?'player':'banker';
   const returned=outcome==='tie'&&pick!=='tie'?stake:pick!==outcome?0:pick==='tie'?stake*9:pick==='banker'?stake+Math.floor(stake*95/100):stake*2;
   this.play(userId,stake,returned,ctx,'baccarat',{pick,player,banker,playerTotal,bankerTotal,outcome});
   return {pick,stake,player,banker,playerTotal,bankerTotal,outcome,returned};
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
 decline({guildId,userId,challengeId,context:ctx}){
  return this.store.operation(ctx,`duel-decline:${guildId}:${userId}:${challengeId}`,()=>{
   const d=this.store.db.prepare('SELECT * FROM point_game_duels WHERE id=?').get(challengeId);
   if(!d||d.guild_id!==String(guildId)||d.status!=='pending'||ctx.now>=d.expires_at)throw new Error('Duel is no longer pending');
   if(d.opponent!==String(userId))throw new Error('Only the challenged opponent can decline');
   this.store.db.prepare("UPDATE point_game_duels SET status='declined' WHERE id=?").run(challengeId);
   return {challenger:d.challenger,opponent:d.opponent};
  });
 }
}
module.exports={PointGames};
