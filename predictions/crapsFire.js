'use strict';
const points=[4,5,6,8,9,10];
function ensure(g,round,newTable=false){
 const db=g.store.db,old=db.prepare('SELECT * FROM point_craps_fire_hands WHERE guild_id=? AND channel_id=?').get(round.guild_id,round.channel_id);
 if(!old||!old.active||newTable&&old.shooter!==round.shooter){
  db.prepare(`INSERT INTO point_craps_fire_hands(guild_id,channel_id,shooter,made_mask,started,active) VALUES (?,?,?,0,?,1)
   ON CONFLICT(guild_id,channel_id) DO UPDATE SET shooter=excluded.shooter,made_mask=0,started=excluded.started,active=1`).run(round.guild_id,round.channel_id,round.shooter,round.state==='point'||!old&&!newTable?1:0);
 }
 return db.prepare('SELECT * FROM point_craps_fire_hands WHERE guild_id=? AND channel_id=?').get(round.guild_id,round.channel_id);
}
function settle(g,round,sum,ctx){
 const hand=ensure(g,round);let mask=hand.made_mask,started=hand.started;
 if(round.state==='open'&&points.includes(sum))started=1;
 if(round.state==='point'&&sum===round.point)mask|=1<<points.indexOf(sum);
 const count=points.filter((_,i)=>mask&(1<<i)).length,sevenOut=round.state==='point'&&sum===7,completed=count===6;
 const db=g.store.db,fireBets=db.prepare("SELECT * FROM point_craps_wagers WHERE round_id=? AND kind='fire' AND status='active'").all(round.id);db.prepare('UPDATE point_craps_fire_hands SET made_mask=?,started=?,active=? WHERE guild_id=? AND channel_id=?').run(mask,started,sevenOut?0:1,round.guild_id,round.channel_id);
 const results=[];
 if(sevenOut||completed){
  for(const bet of fireBets){
   const multiplier=count===6?1000:count===5?250:count===4?25:0,returned=bet.stake*multiplier;
   if(returned)g.store.change(bet.user_id,returned,ctx,{kind:'game_payout',entryKey:`fire-pay:${bet.id}`,metadata:{game:'craps',roundId:round.id,wagerId:bet.id,points:count}});
   const delta=returned-bet.stake;if(delta)g.store.entry(ctx,{kind:delta>0?'house_funding':'house_collection',amount:Math.abs(delta),entryKey:`fire-house:${bet.id}`,metadata:{game:'craps',roundId:round.id,wagerId:bet.id}});
   db.prepare("UPDATE point_craps_wagers SET status='settled' WHERE id=?").run(bet.id);results.push({userId:bet.user_id,kind:'fire',stake:bet.stake,returned});
  }
 }
 return {results,made:points.filter((_,i)=>mask&(1<<i)),sevenOut,inPlay:fireBets.length>0};
}
module.exports={ensure,settle};
