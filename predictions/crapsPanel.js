'use strict';
const {ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder}=require('discord.js');
const nums=[4,5,6,8,9,10];
const option=(label,value)=>({label,value});
const groups=[
 [option('Pass line','pass'),option("Don't pass",'dont'),option('Come','come'),option("Don't come",'dontcome'),...nums.map(n=>option(`Place ${n}`,`place_${n}`))],
 [option('Field','field'),option('Any craps (2, 3, 12)','anycraps'),...[4,6,8,10].map(n=>option(`Hard ${n}`,`hardway_${n}`)),...nums.map(n=>option(`Lay ${n}`,`lay_${n}`)),...[2,3,11,12].map(n=>option(`Roll ${n}`,`prop_${n}`))],
 [option('Pass odds','odds_pass'),option("Don't pass odds",'odds_dont'),...nums.map(n=>option(`Come odds ${n}`,`odds_come_${n}`)),...nums.map(n=>option(`Don't come odds ${n}`,`odds_dontcome_${n}`))]
];
const options=new Map(groups.flat().map(x=>[x.value,x.label]));
function panel(){return {content:'🎲 **Craps table** — choose a wager below, then enter your stake. Use Roll Dice when ready. Use `!craps status` to see all bets.',allowedMentions:{parse:[]},components:[
 ...groups.map((list,index)=>({type:1,components:[{type:3,custom_id:`point-craps:choose:${index}`,placeholder:['Line and place bets','Field, hardways, lays and propositions','Odds bets'][index],min_values:1,max_values:1,options:list}]})),
 {type:1,components:[{type:2,style:1,label:'Roll Dice',custom_id:'point-craps:rolltable'},{type:2,style:2,label:'My Bets',custom_id:'point-craps:mybets'}]}
]};}
async function handle(i,games,casinoChannelId,clock,rollText){
 const id=String(i.customId||'');if(!/^point-craps:choose:[0-2]$/.test(id)&&!['point-craps:rolltable','point-craps:mybets'].includes(id)&&!id.startsWith('point-craps:stake:'))return false;
 if(!i.guildId||!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'This craps table is unavailable in this channel.',ephemeral:true});return true;}
 const table={guildId:i.guildId,channelId:i.channelId,userId:i.user.id},now=()=>({operationKey:`craps-panel:${i.id}`,actorId:String(i.user.id),now:clock()});
 try{
  if(/^point-craps:choose:[0-2]$/.test(id)&&i.isStringSelectMenu?.()){
   const token=i.values?.[0],group=Number(id.at(-1));if(!groups[group].some(x=>x.value===token))throw new Error('Choose a valid craps wager');
   const r=games.crapsStatus(table);if(!r&&!['pass','dont'].includes(token))throw new Error('Craps table is empty. Start with pass or don’t pass.');
   const modal=new ModalBuilder().setCustomId(`point-craps:stake:${r?.id||0}:${r?.roll_version||0}:${token}`).setTitle(options.get(token)).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('stake').setLabel(`Stake (1–${games.maxStake} points)`).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(3)));
   await i.showModal(modal);return true;
  }
  if(id.startsWith('point-craps:stake:')&&i.isModalSubmit?.()){
   const match=/^point-craps:stake:(\d+):(\d+):([a-z0-9_]+)$/.exec(id);if(!match||!options.has(match[3]))throw new Error('Craps control is invalid');
   const r=games.crapsStatus(table);if(String(r?.id||0)!==match[1]||String(r?.roll_version||0)!==match[2])throw new Error('Craps table changed while the wager was open. Choose the bet again.');
   const raw=i.fields.getTextInputValue('stake');const stake=/^[1-9]\d*$/.test(raw)?Number(raw):NaN,token=match[3],parts=token.split('_'),context=now();
   if(['pass','dont'].includes(token))games.crapsJoin({...table,pick:token,stake,context});
   else if(parts[0]==='place')games.crapsPlace({...table,number:Number(parts[1]),stake,context});
   else if(parts[0]==='odds')games.crapsOdds({...table,target:parts[1],number:parts[2]?Number(parts[2]):null,stake,context});
   else games.crapsWager({...table,kind:parts[0],number:parts[1]?Number(parts[1]):null,stake,context});
   await i.reply({content:`🎲 Placed **${stake} points** on **${options.get(token)}**.`,ephemeral:true});return true;
  }
  if(id==='point-craps:rolltable'&&i.isButton?.()){
   const r=games.crapsStatus(table);if(!r)throw new Error('Craps table is empty. Start with pass or don’t pass.');
   const result=games.crapsRoll({...table,roundId:r.id,context:now()});await i.reply({content:rollText(result),allowedMentions:{parse:[]}});return true;
  }
  if(id==='point-craps:mybets'&&i.isButton?.()){
   const r=games.crapsStatus(table);if(!r){await i.reply({content:'There is no active craps table.',ephemeral:true});return true;}
   const db=games.store.db,user=String(i.user.id);
   const bets=db.prepare("SELECT pick AS kind,NULL AS number,stake FROM point_craps_bets WHERE round_id=? AND user_id=? AND status='active' UNION ALL SELECT 'place',number,stake FROM point_craps_places WHERE round_id=? AND user_id=? AND status='active' UNION ALL SELECT kind,number,stake FROM point_craps_wagers WHERE round_id=? AND user_id=? AND status='active' LIMIT 25").all(r.id,user,r.id,user,r.id,user);
   await i.reply({content:`🎲 Your active bets: ${bets.length?bets.map(b=>`${b.stake} on ${b.kind}${b.number?' '+b.number:''}`).join('; '):'none'}. Use \`!craps status\` for the full table.`,ephemeral:true});return true;
  }
  throw new Error('Craps control is invalid');
 }catch(e){const safe=/^(Craps |Choose |Stake must|Insufficient funds|Only the shooter|Point games are paused)/.test(e.message||'')?e.message:'Unable to use the craps table right now.';await i.reply({content:safe,ephemeral:true});return true;}
}
module.exports={panel,handle};
