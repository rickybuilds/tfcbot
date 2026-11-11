'use strict';
const {ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder}=require('discord.js');
const wheel=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const red=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const pocket=n=>`${n===0?'🟢':red.has(n)?'🔴':'⚫'} ${n}`;
const bets=[['Red','red',4],['Black','black',2],['Odd','odd',1],['Even','even',1],['1–18','low',2],['19–36','high',2],['Number 0–36','number',3]];
function table(){return {embeds:[{color:0x57F287,title:'🎡 Roulette',description:'Choose a bet below, then enter your wager. Each bet spins the single-zero wheel immediately.\n\n**Red / Black · Odd / Even · 1–18 / 19–36** pay 1:1\n**Single number** pays 35:1'}],components:[bets.slice(0,4),bets.slice(4)].map(row=>({type:1,components:row.map(([label,pick,style])=>({type:2,style,label,custom_id:`point-roulette:bet:${pick}`}))})),allowedMentions:{parse:[]}};}
function result(r,user){const index=wheel.indexOf(r.number),before=wheel[(index+36)%37],after=wheel[(index+1)%37];const net=r.returned-r.stake;return {embeds:[{color:r.color==='red'?0xed4245:r.color==='black'?0x2b2d31:0x57f287,title:'🎡 Roulette · Spin result',description:`###       ▼\n${pocket(before)}   |   **${pocket(r.number)}**   |   ${pocket(after)}\n\n**Landed on ${r.number} ${r.color}**\n<@${user}> bet **${r.stake} points** on **${r.pick}**.\n\n${net>0?'🎉 **You won!**': '🎲 **No win this spin.**'}\n**${r.returned} points returned** · ${net>0?'+':''}${net} net`}],allowedMentions:{parse:[]}};}
async function handle(i,games,{casinoChannelId,clock,delay=1200}){
 const match=/^point-roulette:(bet|stake):(red|black|odd|even|low|high|number)$/.exec(String(i.customId||''));if(!match)return false;
 if(!i.guildId||!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'Roulette is unavailable in this channel.',ephemeral:true});return true;}
 try{
  if(match[1]==='bet'&&i.isButton?.()){
   const modal=new ModalBuilder().setCustomId(`point-roulette:stake:${match[2]}`).setTitle(match[2]==='number'?'Bet on a number':`Bet on ${match[2]}`);
   if(match[2]==='number')modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('number').setLabel('Number (0–36)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2)));
   modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('stake').setLabel(`Wager (1–${games.maxStake} points)`).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(String(games.maxStake).length)));
   await i.showModal(modal);return true;
  }
  if(match[1]==='stake'&&i.isModalSubmit?.()){
   const raw=i.fields.getTextInputValue('stake'),stake=/^[1-9]\d*$/.test(raw)?Number(raw):NaN,pick=match[2]==='number'?i.fields.getTextInputValue('number'):match[2];
   const r=games.roulette({guildId:i.guildId,userId:i.user.id,pick,stake,context:{operationKey:`roulette-modal:${i.id}`,actorId:String(i.user.id),now:clock()}});
   await i.reply({embeds:[{color:0x57F287,title:'🎡 Roulette · Spinning',description:`<@${i.user.id}> bets **${r.stake} points** on **${r.pick}**.\n\n🔴  ⚫  🟢  🔴  ⚫\n　　　　　　▲\nThe wheel is spinning…`}],allowedMentions:{parse:[]}});
   if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
   try{await i.editReply(result(r,i.user.id));}catch{await i.followUp(result(r,i.user.id));}return true;
  }
  return false;
 }catch(e){const safe=/^(Stake must|Choose |Insufficient funds|Point games are paused)/.test(e.message||'')?e.message:'Unable to use roulette right now.';if(i.replied||i.deferred)await i.followUp({content:safe,ephemeral:true}).catch(()=>{});else await i.reply({content:safe,ephemeral:true});return true;}
}
module.exports={table,result,handle};
