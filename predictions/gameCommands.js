"use strict";
const amount=s=>/^[1-9]\d*$/.test(s||'')?Number(s):NaN;
function register(registry,games,{clock=Date.now,casinoChannelId=''}={}){
 const respond=(m,content)=>m.channel.send({content,allowedMentions:{parse:[]}});
 const wrap=(fn,casinoOnly=false)=>async (m,args)=>{
  if(!m.guild)return;
  if(casinoOnly&&(!casinoChannelId||String(m.channel?.id)!==String(casinoChannelId)))return;
  try{await fn(m,args,{operationKey:`game:${m.id}`,actorId:String(m.author.id),now:clock()});}
  catch(e){
   const known=/^(Stake must|Points must|Choose |Insufficient funds|Only the shooter|Only the challenged opponent|Craps |Duel is no longer pending|Both players need|Point games are paused)/.test(e.message || '');
   await respond(m,known?`Unable to play: ${e.message}`:'Unable to play right now. Please try again later.');
  }
 };
 registry.set('give',wrap(async(m,args,context)=>{
  const recipient=m.mentions?.users?.first();
  const mention=/^<@!?(\d+)>$/.exec(args[0]||'');
  if(args.length!==2||!recipient||recipient.bot||!mention||mention[1]!==String(recipient.id))return respond(m,'Usage: !give @player <points>');
  const r=games.give({userId:m.author.id,recipientId:recipient.id,points:amount(args[1]),context});
  await respond(m,`🎁 <@${r.senderId}> gave <@${r.recipientId}> **${r.points} points**.`);
 }));
 registry.set('roulette',wrap(async(m,args,context)=>{
  if(args.length!==2)return respond(m,'Usage: !roulette <red|black|odd|even|low|high|0-36> <points>');
  const r=games.roulette({guildId:m.guild.id,userId:m.author.id,pick:args[0],stake:amount(args[1]),context});
  await respond(m,`🎰 <@${m.author.id}> bet ${r.stake} on ${r.pick}. The wheel landed on **${r.number} ${r.color}** — **${r.returned} points returned**.`);
 },true));
 registry.set('coinflip',wrap(async(m,args,context)=>{
  if(args.length!==2)return respond(m,'Usage: !coinflip <heads|tails> <points>');
  const r=games.coinflip({userId:m.author.id,pick:args[0],stake:amount(args[1]),context});
  await respond(m,`🪙 <@${m.author.id}> bet ${r.stake} on ${r.pick}. It landed **${r.landed}** — **${r.returned} points returned**.`);
 },true));
 registry.set('baccarat',wrap(async(m,args,context)=>{
  if(args.length!==2)return respond(m,'Usage: !baccarat <player|banker|tie> <points>');
  const r=games.baccarat({userId:m.author.id,pick:args[0],stake:amount(args[1]),context});
  const cards=hand=>hand.map(card=>({1:'A',11:'J',12:'Q',13:'K'}[card]||String(card))).join(', ');
  await respond(m,`🃏 <@${m.author.id}> bet ${r.stake} on ${r.pick}. Player: **${cards(r.player)}** (${r.playerTotal}); Banker: **${cards(r.banker)}** (${r.bankerTotal}). Result: **${r.outcome}** — **${r.returned} points returned**.`);
 },true));
 const crapsButton=id=>[{type:1,components:[{type:2,style:1,label:'Roll Dice',custom_id:`point-craps:roll:${id}`}]}];
 const crapsText=r=>{
  const hits=r.placePayouts||[],shown=hits.slice(0,10).map(p=>`<@${p.userId}> +${p.profit} points on ${p.number}`);
  const payouts=hits.length?` Place payouts: ${shown.join('; ')}${hits.length>10?`; and ${hits.length-10} more`:''}.`:'';
  const extra=(r.wagerResults||[]).map(x=>`<@${x.userId}> ${x.kind}${x.number?' '+x.number:''}: ${x.profit!=null?`+${x.profit} profit (bet stays)`: `${x.returned} returned`}`);
  return `🎲 Rolled **${r.dice.join(' + ')} = ${r.sum}**. ${r.outcome?`Round settled: **${r.outcome==='push'?"12 — pass loses, don't pass pushes":r.outcome+' wins'}**.`:`Point is **${r.point}**; roll again!`}${payouts}${extra.length?` Wagers: ${extra.slice(0,10).join('; ')}${extra.length>10?`; and ${extra.length-10} more`:''}.`:''}${r.fireInPlay?` Fire points made: ${r.firePoints.length?r.firePoints.join(', '):'none'}.`:''}${r.nextRoundId?' Active wagers carry over; automatic place bets are off until a new point is set.':''}`;
 };
 registry.set('craps',wrap(async(m,args,context)=>{
  const [action,...rest]=args,table={guildId:m.guild.id,channelId:m.channel.id,userId:m.author.id,context};
  if(action==='table'&&!rest.length)return m.channel.send(require('./crapsPanel').panel());
  if(action==='join'&&rest.length===2){
   const r=games.crapsJoin({...table,pick:rest[0],stake:amount(rest[1])});
   return m.channel.send({content:`🎲 <@${m.author.id}> joined with **${amount(rest[1])} points** on **${rest[0].toLowerCase()}**. Shooter: <@${r.shooter}>. Join with \`!craps join <pass|dont> <points>\`; then the shooter rolls.`,allowedMentions:{parse:[]},components:String(r.shooter)===String(m.author.id)?crapsButton(r.id):[]});
  }
  if(action==='cancel'&&!rest.length){games.crapsCancel(table);return respond(m,'🎲 Craps round cancelled; all wagers refunded.');}
  if(action==='place'&&rest.length===2){
   const r=games.crapsPlace({...table,number:/^(4|5|6|8|9|10)$/.test(rest[0])?Number(rest[0]):NaN,stake:amount(rest[1])});
   return respond(m,`🎲 <@${m.author.id}> placed **${r.stake} points** on **${r.number}**. The wager remains on the table until taken down or lost on a 7.`);
  }
  if(['field','anycraps','horn','fire','come','dontcome'].includes(action)&&rest.length===1){
   const r=games.crapsWager({...table,kind:action,stake:amount(rest[0])});
   return respond(m,`🎲 <@${m.author.id}> placed **${r.stake} points** on **${r.kind}**.`);
  }
  if(['hardway','lay','prop','craps'].includes(action)&&rest.length===2){
   const aliases={'22':4,'33':6,'44':8,'55':10};const number=action==='hardway'?(aliases[rest[0]]||Number(rest[0])):Number(rest[0]);
   const r=games.crapsWager({...table,kind:action==='craps'?'prop':action,number,stake:amount(rest[1])});
   return respond(m,`🎲 <@${m.author.id}> placed **${r.stake} points** on **${r.kind} ${r.number}**.`);
  }
  if(action==='odds'&&(rest.length===2||rest.length===3)){
   const target=rest[0].toLowerCase(),number=rest.length===3?Number(rest[1]):null,stake=amount(rest.at(-1));
   if((['come','dontcome'].includes(target))!==(rest.length===3))throw new Error('Craps odds require a number for come and dontcome');
   const r=games.crapsOdds({...table,target,number,stake});return respond(m,`🎲 <@${m.author.id}> placed **${r.stake} points** in **${r.target} odds on ${r.number}**.`);
  }
  if(['on','off','auto'].includes(action)&&(rest.length===2||rest.length===3&&rest[0].toLowerCase()==='odds')){
   const kind=rest.length===3?`odds_${rest[1].toLowerCase()}`:rest[0].toLowerCase(),number=Number(rest.at(-1));
   const r=games.crapsWorking({...table,kind,number,working:action});
   return respond(m,`🎲 <@${m.author.id}> set **${r.kind} ${r.number}** to **${r.working}**.`);
  }
  if(action==='take'&&rest.length>=1&&rest.length<=3&&['field','anycraps','horn','fire','prop','hardway','lay','dontcome','odds'].includes(rest[0].toLowerCase())){
   const type=rest[0].toLowerCase(),kind=type==='odds'?`odds_${(rest[1]||'').toLowerCase()}`:type;
   const number=type==='odds'?(rest[2]===undefined?null:Number(rest[2])):(rest[1]===undefined?null:Number(rest[1]));
   const r=games.crapsTakeWager({...table,kind,number});return respond(m,`🎲 <@${m.author.id}> took down **${r.kind}${r.number?' '+r.number:''}** and received **${r.stake} points back**.`);
  }
  if(action==='take'&&rest.length===1){
   if(rest[0].toLowerCase()==='dont'){
    const r=games.crapsTakeLine(table);
    return respond(m,`🎲 <@${m.author.id}> took down their don't pass bet and received **${r.stake} points back**.`);
   }
   const r=games.crapsTake({...table,number:/^(4|5|6|8|9|10)$/.test(rest[0])?Number(rest[0]):NaN});
   return respond(m,`🎲 <@${m.author.id}> took down the **${r.number}** place bet and received **${r.stake} points** back.`);
  }
  if(action==='status'&&(rest.length===0||rest.length===1&&/^[1-9]\d{0,5}$/.test(rest[0]))){
   const r=games.crapsStatus(table);if(!r)return respond(m,'No active craps round. Start one with !craps join pass 10.');
   const page=rest.length?Number(rest[0]):1;
   const all=games.store.db.prepare(`SELECT 0 AS grp,user_id,pick AS kind,NULL AS number,stake,'' AS phase,'' AS working FROM point_craps_bets WHERE round_id=? AND status='active'
    UNION ALL SELECT 1,user_id,'place',number,stake,'',working FROM point_craps_places WHERE round_id=? AND status='active'
    UNION ALL SELECT 2,user_id,kind,number,stake,phase,working FROM point_craps_wagers WHERE round_id=? AND status='active'`).all(r.id,r.id,r.id);
   const pages=Math.max(1,Math.ceil(all.length/10));if(page>pages)throw new Error(`Craps status has ${pages} page(s)`);
   const items=all.slice((page-1)*10,page*10).map(p=>`<@${p.user_id}> ${p.stake} ${p.kind}${p.number?' '+p.number:''}${p.working?` (${p.working}${p.working==='auto'&&p.kind==='place'&&r.state==='open'?': off':''}${['come','dontcome'].includes(p.kind)&&p.phase==='pending'?', awaiting roll':''})`:''}`);
   const fire=all.some(b=>b.kind==='fire')?games.store.db.prepare('SELECT made_mask FROM point_craps_fire_hands WHERE guild_id=? AND channel_id=?').get(String(m.guild.id),String(m.channel.id)):null;
   const made=fire?[4,5,6,8,9,10].filter((_,i)=>fire.made_mask&(1<<i)):[];
   return m.channel.send({content:`🎲 Shooter: <@${r.shooter}>. ${r.state==='open'?'Line betting is open.':`Point: **${r.point}**.`}${fire?` Fire points made: ${made.length?made.join(', '):'none'}.`:''} Bets (page ${page}/${pages}): ${items.length?items.join('; '):'none'}. Use \`!craps status <page>\` for another page. After 10 minutes without a roll, any bettor can roll.`,allowedMentions:{parse:[]},components:crapsButton(r.id)});
  }
  return respond(m,'🎲 **Craps commands** (prefix each with `!craps`):\n`table` opens the betting panel · `status [page]` · `cancel`\n`join <pass|dont> <points>` · `place <number> <points>` · `come <points>` · `dontcome <points>`\n`field <points>` · `anycraps <points>` · `horn <points>` · `fire <points>` · `hardway <4|6|8|10> <points>` · `lay <number> <points>` · `prop <2|3|11|12> <points>`\n`odds <pass|dont> <points>` · `odds <come|dontcome> <number> <points>`\n`on|off|auto <place|hardway|lay> <number>` · `on|off|auto odds <pass|dont|come|dontcome> <number>`\n`take <number|dont|field|anycraps|horn|fire>` · `take <hardway|lay|dontcome|prop> <number>` · `take odds <pass|dont> [number]` · `take odds <come|dontcome> <number>`\nHorn stakes must be multiples of 4. Fire bets must be placed before the first point. Place, hardway and come odds are off on the come-out by default.');
 },true));
 registry.set('duel',wrap(async(m,args,context)=>{
  if(args[0]?.toLowerCase()==='accept'){
   if(args.length!==2||!/^\d+$/.test(args[1]))return respond(m,'Usage: !duel accept <challenge message ID>');
   const r=games.accept({guildId:m.guild.id,userId:m.author.id,challengeId:`game:${args[1]}`,context});
   return respond(m,`⚔️ <@${r.winner}> won ${r.stake} points from <@${r.loser}>!`);
  }
  const opponent=m.mentions?.users?.first();
  if(args.length!==2||!opponent||opponent.bot)return respond(m,'Usage: !duel @player <points>');
  const r=games.challenge({guildId:m.guild.id,userId:m.author.id,opponentId:opponent.id,stake:amount(args[1]),context});
  await m.channel.send({content:`⚔️ <@${m.author.id}> challenged <@${opponent.id}> for ${amount(args[1])} points. The challenge expires <t:${Math.floor(r.expiresAt/1000)}:R>. Both players need enough points when accepted.`,allowedMentions:{parse:[]},components:[{type:1,components:[{type:2,style:3,label:'Accept Duel',custom_id:`point-duel:accept:${m.id}`},{type:2,style:4,label:'Decline Duel',custom_id:`point-duel:decline:${m.id}`}]}]});
 },true));
 return async function handleInteraction(i){
  if(await require('./crapsPanel').handle(i,games,casinoChannelId,clock,crapsText))return true;
  const craps=/^point-craps:roll:(\d+)$/.exec(String(i.customId||''));
  if(craps&&i.isButton()&&i.guildId){
   if(!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'This craps table is unavailable in this channel.',ephemeral:true});return true;}
   try{
    const r=games.crapsRoll({roundId:craps[1],guildId:i.guildId,channelId:i.channelId,userId:i.user.id,context:{operationKey:`craps-button:${i.id}`,actorId:String(i.user.id),now:clock()}});
    const next=r.nextRoundId||(r.state==='point'?r.id:null);
    await i.update({content:`Roll control (updated after each roll): ${crapsText(r)}`,allowedMentions:{parse:[]},components:next?crapsButton(next):[]});
    if(typeof i.followUp==='function'){
     try{await i.followUp({content:crapsText(r),allowedMentions:{parse:[]}});}
     catch(e){console.error('[craps roll history]',e);}
    }
   }catch(e){const known=/^(Only the shooter|Craps )/.test(e.message||'');await i.reply({content:known?e.message:'Unable to roll right now. Please try again later.',ephemeral:true});}
   return true;
  }
  const match=/^point-duel:(accept|decline):(\d+)$/.exec(String(i.customId||''));
  if(!match||!i.isButton()||!i.guildId)return false;
  let result;
  try{
   result=games[match[1]]({guildId:i.guildId,userId:i.user.id,challengeId:`game:${match[2]}`,context:{operationKey:`duel-button:${i.id}`,actorId:String(i.user.id),now:clock()}});
  }catch(e){
   const known=/^(Only the challenged opponent|Duel is no longer pending|Both players need|Point games are paused)/.test(e.message||'');
   await i.reply({content:known?e.message:'Unable to respond to this duel right now. Please try again later.',ephemeral:true});
   return true;
  }
  const content=match[1]==='decline'?`⚔️ <@${result.opponent}> declined <@${result.challenger}>'s duel.`:`⚔️ <@${result.winner}> won ${result.stake} points from <@${result.loser}>!`;
  await i.update({content,components:[],allowedMentions:{parse:[]}});
  return true;
 };
}
module.exports={register};
