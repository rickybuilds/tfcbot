'use strict';
const numbers=[4,5,6,8,9,10];
function wager(g,{guildId,channelId,userId,kind,number=null,stake,context:ctx}){
 g.stake(stake);number=number==null?null:Number(number);
 if(!['field','prop','anycraps','horn','fire','come','dontcome','hardway','lay'].includes(kind)||kind==='prop'&&![2,3,11,12].includes(number)||kind==='hardway'&&![4,6,8,10].includes(number)||kind==='lay'&&!numbers.includes(number))throw new Error('Choose a valid craps wager');
 if(kind==='horn'&&stake%4!==0)throw new Error('Craps horn stake must be a multiple of 4');
 return g.store.operation(ctx,`craps-wager:${guildId}:${channelId}:${userId}:${kind}:${number}:${stake}`,()=>{
  g.checkPause();const round=g.crapsStatus({guildId,channelId});if(!round)throw new Error('Craps table has no active round');
  if(['come','dontcome'].includes(kind)&&round.state!=='point')throw new Error('Craps come bets require an established point');
  if(kind==='fire'){
   const hand=require('./crapsFire').ensure(g,round);
   if(hand.started||round.state!=='open')throw new Error('Craps fire bets must be placed before the shooter establishes their first point');
   if(g.store.db.prepare("SELECT 1 FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind='fire' AND status='active'").get(round.id,String(userId)))throw new Error('Craps fire bet already exists');
  }
  if(['hardway','lay'].includes(kind)&&g.store.db.prepare("SELECT 1 FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind=? AND number=? AND status='active'").get(round.id,String(userId),kind,number))throw new Error('Craps wager already exists on that number');
  g.store.change(userId,-stake,ctx,{kind:'game_stake',entryKey:'stake',metadata:{game:'craps',roundId:round.id,kind,number}});
  const id=Number(g.store.db.prepare("INSERT INTO point_craps_wagers(round_id,user_id,kind,number,stake) VALUES (?,?,?,?,?)").run(round.id,String(userId),kind,number,stake).lastInsertRowid);
  return {id,kind,number,stake};
 });
}
function settle(g,round,dice,ctx){
 const sum=dice[0]+dice[1],out=[];
 const bets=g.store.db.prepare("SELECT * FROM point_craps_wagers WHERE round_id=? AND status='active' ORDER BY id").all(round.id);
 for(const b of bets){
  let returned=null;
  if(b.kind.startsWith('odds_')){
   const target=b.kind.slice(5),parent=b.parent_id?bets.find(p=>p.id===b.parent_id):null;
   const point=parent?parent.number:round.point,flatActive=parent?parent.phase==='point':round.state==='point';
   if(!flatActive)continue;
   const resolved=sum===7||sum===point;if(!resolved)continue;
   const dark=target==='dont'||target==='dontcome',won=dark?sum===7:sum===point;
   const on=b.working==='on'||b.working==='auto'&&(target!=='come'||round.state==='point');
   if(!on)returned=b.stake;
   else if(!won)returned=0;
   else {const ratio=[4,10].includes(point)?[2,1]:[5,9].includes(point)?[3,2]:[6,5];const [n,d]=dark?[ratio[1],ratio[0]]:ratio;returned=b.stake+Math.floor(b.stake*n/d);}
  }
  if(b.kind==='field')returned=[2,12].includes(sum)?b.stake*3:[3,4,9,10,11].includes(sum)?b.stake*2:0;
  if(b.kind==='prop')returned=sum===b.number?b.stake*(b.number===2||b.number===12?31:16):0;
  if(b.kind==='anycraps')returned=[2,3,12].includes(sum)?b.stake*8:0;
  if(b.kind==='horn')returned=[2,12].includes(sum)?b.stake/4*31:[3,11].includes(sum)?b.stake/4*16:0;
  if(['hardway','lay'].includes(b.kind)){
   const active=b.working==='on'||b.working==='auto'&&(b.kind==='lay'||round.state==='point');
   if(!active)continue;
   if(b.kind==='hardway'){
    if(sum===7||sum===b.number&&dice[0]!==dice[1])returned=0;
    else if(sum===b.number&&dice[0]===dice[1]){
     const profit=b.stake*([4,10].includes(b.number)?7:9);
     g.store.change(b.user_id,profit,ctx,{profit,kind:'game_payout',entryKey:`wager-profit:${b.id}`,metadata:{game:'craps',roundId:round.id,wagerId:b.id}});
     g.store.entry(ctx,{kind:'house_funding',amount:profit,entryKey:`wager-fund:${b.id}`,metadata:{game:'craps',roundId:round.id,wagerId:b.id}});
     out.push({userId:b.user_id,kind:b.kind,number:b.number,stake:b.stake,profit});
    }
   }else if(sum===b.number)returned=0;
   else if(sum===7){const [n,d]=[4,10].includes(b.number)?[1,2]:[5,9].includes(b.number)?[2,3]:[5,6];const profit=Math.floor(b.stake*n/d);returned=b.stake+Math.max(0,profit-Math.ceil(profit/20));}
  }
  if(['come','dontcome'].includes(b.kind)){
   if(b.phase==='pending'){
    if([7,11].includes(sum))returned=b.kind==='come'?b.stake*2:0;
    else if([2,3].includes(sum))returned=b.kind==='dontcome'?b.stake*2:0;
    else if(sum===12)returned=b.kind==='dontcome'?b.stake:0;
    else {g.store.db.prepare("UPDATE point_craps_wagers SET phase='point',number=? WHERE id=?").run(sum,b.id);continue;}
   }else if(sum===7)returned=b.kind==='dontcome'?b.stake*2:0;
   else if(sum===b.number)returned=b.kind==='come'?b.stake*2:0;
  }
  if(returned===null)continue;
  if(returned)g.store.change(b.user_id,returned,ctx,{profit:Math.max(0,returned-b.stake),kind:'game_payout',entryKey:`wager-pay:${b.id}`,metadata:{game:'craps',roundId:round.id,wagerId:b.id,kind:b.kind}});
  const difference=returned-b.stake;if(difference)g.store.entry(ctx,{kind:difference>0?'house_funding':'house_collection',amount:Math.abs(difference),entryKey:`wager-house:${b.id}`,metadata:{game:'craps',roundId:round.id,wagerId:b.id}});
  g.store.db.prepare("UPDATE point_craps_wagers SET status='settled' WHERE id=?").run(b.id);
  out.push({userId:b.user_id,kind:b.kind,number:b.number,stake:b.stake,returned});
 }
 return out;
}
function working(g,{guildId,channelId,userId,kind,number,working,context:ctx}){
 if(!['on','off','auto'].includes(working)||!['place','hardway','lay','odds_pass','odds_dont','odds_come','odds_dontcome'].includes(kind))throw new Error('Choose a valid craps wager and on, off, or auto');
 return g.store.operation(ctx,`craps-working:${guildId}:${channelId}:${userId}:${kind}:${number}:${working}`,()=>{
  const round=g.crapsStatus({guildId,channelId});
  if(kind==='place'){
   const bet=round&&g.store.db.prepare("SELECT * FROM point_craps_places WHERE round_id=? AND user_id=? AND number=? AND status='active'").get(round.id,String(userId),Number(number));
   if(!bet)throw new Error('Craps wager not found');g.store.db.prepare('UPDATE point_craps_places SET working=? WHERE round_id=? AND user_id=? AND number=?').run(working,round.id,String(userId),Number(number));return {kind,number:bet.number,working};
  }
  const bet=round&&g.store.db.prepare("SELECT * FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind=? AND number=? AND status='active'").get(round.id,String(userId),kind,Number(number));
  if(!bet)throw new Error('Craps wager not found');g.store.db.prepare('UPDATE point_craps_wagers SET working=? WHERE id=?').run(working,bet.id);return {kind,number:bet.number,working};
 });
}
function odds(g,{guildId,channelId,userId,target,number=null,stake,context:ctx}){
 g.stake(stake);if(!['pass','dont','come','dontcome'].includes(target))throw new Error('Choose pass, dont, come, or dontcome odds');
 return g.store.operation(ctx,`craps-odds:${guildId}:${channelId}:${userId}:${target}:${number}:${stake}`,()=>{
  g.checkPause();const round=g.crapsStatus({guildId,channelId});if(!round)throw new Error('Craps table has no active round');
  let parent=null,point;
  if(['pass','dont'].includes(target)){
   if(round.state!=='point'||!g.store.db.prepare("SELECT 1 FROM point_craps_bets WHERE round_id=? AND user_id=? AND pick=? AND status='active'").get(round.id,String(userId),target))throw new Error('Craps odds require your established line bet');
   point=round.point;
  }else{
   parent=g.store.db.prepare("SELECT * FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind=? AND number=? AND phase='point' AND status='active' ORDER BY id LIMIT 1").get(round.id,String(userId),target,Number(number));
   if(!parent)throw new Error('Craps odds require your established come bet on that number');point=parent.number;
  }
  const kind=`odds_${target}`;
  if(g.store.db.prepare("SELECT 1 FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind=? AND number=? AND status='active'").get(round.id,String(userId),kind,point))throw new Error('Craps odds already exist on that bet');
  g.store.change(userId,-stake,ctx,{kind:'game_stake',entryKey:'stake',metadata:{game:'craps',roundId:round.id,kind,number:point}});
  const id=Number(g.store.db.prepare("INSERT INTO point_craps_wagers(round_id,user_id,kind,number,stake,parent_id) VALUES (?,?,?,?,?,?)").run(round.id,String(userId),kind,point,stake,parent?.id??null).lastInsertRowid);
  return {id,target,number:point,stake};
 });
}
function take(g,{guildId,channelId,userId,kind,number=null,context:ctx}){
 if(!['field','prop','anycraps','horn','fire','hardway','lay','dontcome','odds_pass','odds_dont','odds_come','odds_dontcome'].includes(kind))throw new Error('Craps wager cannot be taken down');
 return g.store.operation(ctx,`craps-take-wager:${guildId}:${channelId}:${userId}:${kind}:${number}`,()=>{
  const round=g.crapsStatus({guildId,channelId});
  const bets=round?g.store.db.prepare("SELECT * FROM point_craps_wagers WHERE round_id=? AND user_id=? AND kind=? AND status='active' ORDER BY id").all(round.id,String(userId),kind):[];
  const bet=bets.find(b=>number==null||b.number===Number(number));if(!bet)throw new Error('Craps wager not found');
  if(kind==='fire'&&require('./crapsFire').ensure(g,round).started)throw new Error('Craps fire bets cannot be removed after the shooter establishes a point');
  const attached=g.store.db.prepare("SELECT * FROM point_craps_wagers WHERE parent_id=? AND status='active'").all(bet.id);let total=0;
  for(const item of [bet,...attached]){
   g.store.change(userId,item.stake,ctx,{kind:'game_payout',entryKey:`refund:${item.id}`,metadata:{game:'craps',roundId:round.id,wagerId:item.id,refund:true}});
   g.store.db.prepare("UPDATE point_craps_wagers SET status='refunded' WHERE id=?").run(item.id);total+=item.stake;
  }
  return {kind,number:bet.number,stake:total};
 });
}
module.exports={wager,settle,working,odds,take};
