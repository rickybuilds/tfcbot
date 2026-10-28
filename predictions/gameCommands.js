"use strict";
const amount=s=>/^[1-9]\d*$/.test(s||'')?Number(s):NaN;
function register(registry,games,{clock=Date.now}={}){
 const respond=(m,content)=>m.channel.send({content,allowedMentions:{parse:[]}});
 const wrap=fn=>async (m,args)=>{
  if(!m.guild)return;
  try{await fn(m,args,{operationKey:`game:${m.id}`,actorId:String(m.author.id),now:clock()});}
  catch(e){
   const known=/^(Stake must|Points must|Choose |Insufficient funds|Only the challenged opponent|Duel is no longer pending|Both players need|Point games are paused)/.test(e.message || '');
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
 }));
 registry.set('coinflip',wrap(async(m,args,context)=>{
  if(args.length!==2)return respond(m,'Usage: !coinflip <heads|tails> <points>');
  const r=games.coinflip({userId:m.author.id,pick:args[0],stake:amount(args[1]),context});
  await respond(m,`🪙 <@${m.author.id}> bet ${r.stake} on ${r.pick}. It landed **${r.landed}** — **${r.returned} points returned**.`);
 }));
 registry.set('duel',wrap(async(m,args,context)=>{
  if(args[0]?.toLowerCase()==='accept'){
   if(args.length!==2||!/^\d+$/.test(args[1]))return respond(m,'Usage: !duel accept <challenge message ID>');
   const r=games.accept({guildId:m.guild.id,userId:m.author.id,challengeId:`game:${args[1]}`,context});
   return respond(m,`⚔️ <@${r.winner}> won ${r.stake} points from <@${r.loser}>!`);
  }
  const opponent=m.mentions?.users?.first();
  if(args.length!==2||!opponent||opponent.bot)return respond(m,'Usage: !duel @player <points>');
  const r=games.challenge({guildId:m.guild.id,userId:m.author.id,opponentId:opponent.id,stake:amount(args[1]),context});
  await m.channel.send({content:`⚔️ <@${m.author.id}> challenged <@${opponent.id}> for ${amount(args[1])} points. The challenge expires <t:${Math.floor(r.expiresAt/1000)}:R>. Both players need enough points when accepted.`,allowedMentions:{parse:[]},components:[{type:1,components:[{type:2,style:3,label:'Accept Duel',custom_id:`point-duel:accept:${m.id}`}]}]});
 }));
 return async function handleInteraction(i){
  const match=/^point-duel:accept:(\d+)$/.exec(String(i.customId||''));
  if(!match||!i.isButton()||!i.guildId)return false;
  let result;
  try{
   result=games.accept({guildId:i.guildId,userId:i.user.id,challengeId:`game:${match[1]}`,context:{operationKey:`duel-button:${i.id}`,actorId:String(i.user.id),now:clock()}});
  }catch(e){
   const known=/^(Only the challenged opponent|Duel is no longer pending|Both players need|Point games are paused)/.test(e.message||'');
   await i.reply({content:known?e.message:'Unable to accept this duel right now. Please try again later.',ephemeral:true});
   return true;
  }
  await i.update({content:`⚔️ <@${result.winner}> won ${result.stake} points from <@${result.loser}>!`,components:[],allowedMentions:{parse:[]}});
  return true;
 };
}
module.exports={register};
