'use strict';
const OFFER_MS=15*60*1000;
const fmt=n=>BigInt(n).toLocaleString('en-US');
function register(registry,service){registry.set('loan',async(message,args)=>{
 if(!message.guild||!service.config.predictionsOwnerId||String(message.author.id)!==service.config.predictionsOwnerId)return;
 const match=/^(?:<@!?(\d{15,22})>|(\d{15,22}))$/.exec(args[0]||''),amount=/^[1-9]\d*$/.test(args[1]||'')?Number(args[1]):NaN;
 const send=payload=>message.channel.send(payload);
 if(!match||!Number.isSafeInteger(amount))return send({content:'Usage: !loan <Discord ID|@player> <positive whole points>',allowedMentions:{parse:[]}});
 try{
  const user=match[1]||match[2],id=String(message.id),now=service.clock(),interest=Math.ceil(amount/10);
  const offer=service.store.atomic(()=>{
   const old=service.store.db.prepare('SELECT * FROM point_loan_offers WHERE id=?').get(id);
   if(old){if(old.user_id!==user||old.amount!==amount||old.owner_id!==String(message.author.id)||old.guild_id!==String(message.guild.id)||old.channel_id!==String(message.channel.id))throw new Error('Loan offer conflict');return old;}
   const status=service.store.loanStatus(user);if(amount>status.limit-status.principal)throw new Error(`Loan exceeds the limit: ${Math.max(0,status.limit-status.principal)} points available`);
   service.store.db.prepare("INSERT INTO point_loan_offers VALUES (?,?,?,?,?,?,?,?, 'pending')").run(id,String(message.guild.id),String(message.channel.id),user,String(message.author.id),amount,interest,now+OFFER_MS);
   return service.store.db.prepare('SELECT * FROM point_loan_offers WHERE id=?').get(id);
  });
  if(offer.status!=='pending'||now>=offer.expires_at)return send({content:'This loan offer is no longer pending.',allowedMentions:{parse:[]}});
  return send({content:`🏦 **Loan offer for <@${user}>**\nBorrow: **${fmt(offer.amount)} points** · Interest (10%, rounded up): **${fmt(offer.interest)} points**\nTotal to repay: **${fmt(BigInt(offer.amount)+BigInt(offer.interest))} points**\nFuture casino, duel, and prediction winning profit automatically repays the loan, principal first. Your returned stake is not taken.\nThe loan is issued only if you accept. Offer expires <t:${Math.floor(offer.expires_at/1000)}:R>.`,components:[{type:1,components:[{type:2,style:3,label:'Accept loan',custom_id:`point-loan:accept:${id}`},{type:2,style:4,label:'Decline',custom_id:`point-loan:decline:${id}`}]}],allowedMentions:{parse:[],users:[user]}});
 }catch(e){return send({content:/^Loan exceeds the limit/.test(e.message)?e.message:'Unable to offer loan. Check the amount and try again.',allowedMentions:{parse:[]}});}
 });}
async function handleInteraction(i,service){
 const match=/^point-loan:(accept|decline):([a-zA-Z0-9_-]+)$/.exec(String(i.customId||''));if(!match||!i.isButton?.())return false;
 try{
  const result=service.store.atomic(()=>{
   const offer=service.store.db.prepare('SELECT * FROM point_loan_offers WHERE id=?').get(match[2]);
   if(!offer||offer.guild_id!==String(i.guildId)||offer.channel_id!==String(i.channelId))throw new Error('Loan offer is unavailable.');
   if(offer.user_id!==String(i.user.id))throw new Error('Only the player offered this loan can respond.');
   if(offer.status!=='pending')throw new Error('This loan offer has already been answered.');
   if(service.clock()>=offer.expires_at)throw new Error('This loan offer has expired.');
   if(match[1]==='accept'){const loan=service.store.issueLoan(offer.user_id,offer.amount,{operationKey:`loan-accepted:${offer.id}`,actorId:String(i.user.id),reason:`Loan offered by ${offer.owner_id}`,now:service.clock()});if(loan.interestAdded!==offer.interest)throw new Error('Loan terms changed. Please request a new offer.');}
   const status=match[1]==='accept'?'accepted':'declined';service.store.db.prepare('UPDATE point_loan_offers SET status=? WHERE id=?').run(status,offer.id);
   return {offer,status};
  });
  await i.update({content:`🏦 <@${result.offer.user_id}> **${result.status}** the loan offer${result.status==='accepted'?` for **${fmt(result.offer.amount)} points**, with **${fmt(result.offer.interest)} points** interest. Winning profit automatically repays the loan.`:'.'}`,components:[],allowedMentions:{parse:[]}});
 }catch(e){const safe=/^(Loan exceeds the limit|Loan offer is unavailable|Only the player offered|This loan offer|Loan terms changed)/.test(e.message||'')?e.message:'Unable to process this loan offer. Please try again.';if(i.replied||i.deferred)await i.followUp({content:safe,ephemeral:true}).catch(()=>{});else await i.reply({content:safe,ephemeral:true});}
 return true;
}
module.exports={register,handleInteraction};
