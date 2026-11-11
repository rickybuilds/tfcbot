'use strict';
const {ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder}=require('discord.js');
const bid=(id,action,extra='')=>`point-bj:${id}:${action}${extra?`:${extra}`:''}`;
const face=c=>`${c.rank===1?'A':c.rank>10?({11:'J',12:'Q',13:'K'}[c.rank]):c.rank}${c.suit}`;
const score=cards=>require('./blackjack').total(cards);
function panel(r){
 const components=[];
 if(r.state==='joining'){
  const buttons=[];for(let seat=1;seat<=5;seat++){const s=r.seats.find(x=>x.seat===seat);buttons.push({type:2,style:s?2:1,label:s?`Seat ${seat}: taken`:`Seat ${seat}`,custom_id:bid(r.id,'seat',seat),disabled:!!s});}components.push({type:1,components:buttons});
  const seated=r.seats.length>0;components.push({type:1,components:[{type:2,style:3,label:'Deal now',custom_id:bid(r.id,'deal'),disabled:!seated},{type:2,style:2,label:'Wait for players',custom_id:bid(r.id,'wait'),disabled:!seated}]});
  return {content:`🃏 **Blackjack table** — seats open · ${r.seats.length}/5 joined · closes <t:${Math.floor(r.deadline/1000)}:R>\n${r.seats.map(s=>`Seat ${s.seat}: <@${s.user_id}> · ${s.stake} points`).join('\n')||'Choose a seat and enter your wager privately (1–500 points).'}`,components,allowedMentions:{parse:[]}};
 }
 const dealer=r.dealerCards||[],hands=r.seats.flatMap(s=>s.hands.map(h=>({seat:s.seat,user:s.user_id,h})));
 if(r.state==='playing'){
  const hand=r.seats.find(s=>s.seat===r.current_seat)?.hands.find(h=>h.state==='active'),buttons=hand?[{type:2,style:1,label:'Hit',custom_id:bid(r.id,'hit',hand.id)},{type:2,style:2,label:'Stand',custom_id:bid(r.id,'stand',hand.id)},{type:2,style:1,label:'Double',custom_id:bid(r.id,'double',hand.id),disabled:hand.cards.length!==2||hand.doubled===1},{type:2,style:3,label:'Split',custom_id:bid(r.id,'split',hand.id),disabled:hand.cards.length!==2||hand.hand_no!==1||hand.cards[0].rank!==hand.cards[1].rank}]:[];if(buttons.length)components.push({type:1,components:buttons});
 }
 const dealerShown=r.state==='playing'?`${face(dealer[0])} · 🂠`:`${dealer.map(face).join(' · ')} (${score(dealer)})`;
 const lines=hands.map(({seat,user,h})=>`Seat ${seat} <@${user}> · Hand ${h.hand_no}: ${h.cards.map(face).join(' · ')} (${score(h.cards)}) · ${h.state}${h.result?` — ${h.result}`:''} · ${h.stake} points`);
  const result=r.state==='settled'?`\n**Round settled** — dealer ${score(dealer)}.`:r.state==='cancelled'?'\nNo players joined. The table closed without a deal.':'';
 return {content:`🃏 **Blackjack**\nDealer: ${dealerShown}${r.state==='playing'?` · <@${r.seats.find(s=>s.seat===r.current_seat)?.user_id}> to act`:''}\n${lines.join('\n')}${result}`,components,allowedMentions:{parse:[]}};
}
async function handle(i,games,{casinoChannelId,clock=Date.now,refresh,schedule}){
 const m=/^point-bj:(\d+):(seat|deal|wait|hit|stand|double|split)(?::(\d+))?$/.exec(String(i.customId||''));if(!m)return false;
 if(!i.isButton?.())return false;if(!i.guildId||!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'This blackjack table is unavailable in this channel.',ephemeral:true});return true;}
 const [,id,act,extra]=m,ctx={operationKey:`blackjack-button:${i.id}`,actorId:String(i.user.id),now:clock()},args={roundId:id,guildId:i.guildId,channelId:i.channelId,userId:i.user.id,context:ctx};
 try{
  if(act==='seat'){
   const seat=Number(extra),modal=new ModalBuilder().setCustomId(`point-bj:stake:${id}:${seat}`).setTitle(`Join seat ${seat}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('stake').setLabel('Wager (1–500 points)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(3)));
   await i.showModal(modal);return true;
  }
  if(act==='split'){
   const hand=games.blackjackStatus(args)?.seats.flatMap(s=>s.hands).find(h=>h.id===Number(extra));if(!hand||hand.user_id!==String(i.user.id))throw new Error('Only the hand owner can split');
   const modal=new ModalBuilder().setCustomId(`point-bj:splitstake:${id}:${extra}`).setTitle('Split hand wager').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('stake').setLabel('Second hand wager (1–500)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(3)));
   await i.showModal(modal);return true;
  }
  if(act==='wait'){const r=games.blackjackStatus(args);if(!r||r.state!=='joining')throw new Error('Blackjack table is no longer open');await i.reply({content:'⏳ The table will deal when its 60-second timer ends, or a seated player can press Deal now.',ephemeral:true});return true;}
  let r;if(act==='deal'){r=games.blackjackDeal(args);}
  else {const h=games.blackjackStatus(args)?.seats.flatMap(s=>s.hands).find(h=>h.id===Number(extra));r=games.blackjackAction({...args,handId:Number(extra),action:act,stake:act==='double'?h?.stake:undefined});}
  await i.update(panel(r));if(r.state==='playing')schedule?.(r);return true;
 }catch(e){await i.reply({content:/^(Blackjack |Only the hand owner|It is not your turn|You already have|That seat|Only a seated)/.test(e.message||'')?e.message:'Unable to use the blackjack table right now.',ephemeral:true});return true;}
}
async function handleModal(i,games,{casinoChannelId,clock=Date.now,refresh,schedule}){
 const split=/^point-bj:splitstake:(\d+):(\d+)$/.exec(String(i.customId||''));
 const m=/^point-bj:stake:(\d+):(\d+)$/.exec(String(i.customId||''));if(!m&&!split)return false;
 if(!i.isModalSubmit?.())return false;if(!i.guildId||!casinoChannelId||String(i.channelId)!==String(casinoChannelId)){await i.reply({content:'This blackjack table is unavailable in this channel.',ephemeral:true});return true;}
 try{const raw=i.fields.getTextInputValue('stake'),stake=/^[1-9]\d*$/.test(raw)?Number(raw):NaN,context={operationKey:`blackjack-modal:${i.id}`,actorId:String(i.user.id),now:clock()};let r;if(split){r=games.blackjackAction({roundId:split[1],guildId:i.guildId,channelId:i.channelId,userId:i.user.id,handId:Number(split[2]),action:'split',stake,context});await i.reply({content:`🃏 Split added with **${stake} points** on the second hand.`,ephemeral:true});}else{r=games.blackjackJoin({roundId:m[1],guildId:i.guildId,channelId:i.channelId,userId:i.user.id,seat:Number(m[2]),stake,context});await i.reply({content:`🃏 Seat ${m[2]} reserved with **${stake} points**.`,ephemeral:true});}await refresh?.(r);schedule?.(r);return true;}catch(e){const message=/^(Blackjack |You already have|That seat|Insufficient funds|Only the hand owner|It is not your turn)/.test(e.message||'')?e.message:'Unable to use the blackjack table right now.';if(i.replied||i.deferred)await i.followUp({content:message,ephemeral:true}).catch(()=>{});else await i.reply({content:message,ephemeral:true});return true;}
}
module.exports={panel,handle,handleModal};
