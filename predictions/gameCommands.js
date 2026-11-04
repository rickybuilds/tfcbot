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
 const crapsText=r=>`🎲 Rolled **${r.dice.join(' + ')} = ${r.sum}**. ${r.outcome?`Round settled: **${r.outcome==='push'?"12 — pass loses, don't pass pushes":r.outcome+' wins'}**.`:`Point is **${r.point}**; roll again!`} `;
 registry.set('craps',wrap(async(m,args,context)=>{
  const [action,...rest]=args,table={guildId:m.guild.id,channelId:m.channel.id,userId:m.author.id,context};
  if(action==='join'&&rest.length===2){
   const r=games.crapsJoin({...table,pick:rest[0],stake:amount(rest[1])});
   return m.channel.send({content:`🎲 <@${m.author.id}> joined with **${amount(rest[1])} points** on **${rest[0].toLowerCase()}**. Shooter: <@${r.shooter}>. Join with \`!craps join <pass|dont> <points>\`; then the shooter rolls.`,allowedMentions:{parse:[]},components:crapsButton(r.id)});
  }
  if(action==='cancel'&&!rest.length){games.crapsCancel(table);return respond(m,'🎲 Craps round cancelled; all wagers refunded.');}
  if(action==='status'&&!rest.length){const r=games.crapsStatus(table);if(!r)return respond(m,'No active craps round. Start one with !craps join pass 10.');return m.channel.send({content:`🎲 Shooter: <@${r.shooter}>. ${r.state==='open'?'Betting is open.':`Point: **${r.point}**; betting is closed.`} After 10 minutes without a roll, any bettor can roll.`,allowedMentions:{parse:[]},components:crapsButton(r.id)});}
  return respond(m,'Usage: !craps join <pass|dont> <points> | !craps status | !craps cancel');
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
  const craps=/^point-craps:roll:(\d+)$/.exec(String(i.customId||''));
  if(craps&&i.isButton()&&i.guildId){
   if(!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'This craps table is unavailable in this channel.',ephemeral:true});return true;}
   try{
    const r=games.crapsRoll({roundId:craps[1],guildId:i.guildId,channelId:i.channelId,userId:i.user.id,context:{operationKey:`craps-button:${i.id}`,actorId:String(i.user.id),now:clock()}});
    await i.reply({content:crapsText(r),allowedMentions:{parse:[]},components:r.state==='point'?crapsButton(r.id):[]});
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
