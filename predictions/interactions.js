"use strict";
const {ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
const {isOpen}=require("./messages");
async function privateReply(i,payload) {
  const body=typeof payload==="string"?{content:payload}:payload;
  if(i.deferred||i.replied)return i.followUp({...body,flags:64});
  return i.reply({...body,flags:64});
}
async function handleInteraction(service,i) {
  if(!String(i.customId||"").startsWith("pred:"))return false;
  try{
    const parts=i.customId.split(":");
    if(parts[1]==="confirm") {await require("./admin").confirm(service,i,parts[2]);return true;}
    const [,action,rawId,rawRevision,pick]=parts;
    if(!/^\d+$/.test(rawId)||!/^\d+$/.test(rawRevision))throw new Error("Invalid prediction control");
    const marketRef={marketId:Number(rawId),revision:Number(rawRevision)},m=service.store.market(marketRef.marketId),user=String(i.user.id);
    if(!m||m.revision!==marketRef.revision)throw new Error("Stale prediction market");
    // Public controls are accepted only on the bound card. Ephemeral controls/modals
    // are still actor-bound by Discord, and never take an account ID from custom_id.
    if(["pick","mine"].includes(action)&&i.message&&m.message_id&&String(i.message.id)!==m.message_id&&!i.message.flags?.has?.(64))throw new Error("Stale prediction message");
    const ctx={operationKey:`discord:${i.id}`,actorId:user,now:service.clock()};
    if(action==="pick"){
      service.store.mutable(marketRef,ctx.now);
      if(!["blue","red","tie"].includes(pick))throw new Error("Invalid pick");
      const b=service.store.bets(m.id).find(b=>b.discord_id===user&&b.status==="active");
      const modal=new ModalBuilder().setCustomId(`pred:submit:${m.id}:${m.revision}:${pick}`).setTitle(`Predict ${pick.toUpperCase()} — ${m.match_id}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("stake").setLabel("Stake (1–250 points)").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(3).setValue(String(b?.stake||100))));
      await i.showModal(modal);
    }else if(action==="submit"){
      const raw=i.fields.getTextInputValue("stake");if(!/^\d{1,3}$/.test(raw))throw new Error("Stake must be a whole number from 1 to 250");
      const result=service.store.placeBet({marketRef,discordId:user,pick,stake:Number(raw),context:ctx});
      await privateReply(i,`Match ${m.match_id}: ${result.pick.toUpperCase()}, stake ${result.stake}. Available balance: ${result.balance.toLocaleString("en-US")}.`);
    }else if(action==="cancel"){
      const result=service.store.cancelBet({marketRef,discordId:user,context:ctx});await privateReply(i,`${result.cancelled?"Bet cancelled and stake refunded.":"No active bet."} Available balance: ${result.balance.toLocaleString("en-US")}.`);
    }else if(action==="mine"){
      const b=service.store.bets(m.id).find(b=>b.discord_id===user),account=service.store.ensureAccount(user,ctx);
      const lines=[`Match ${m.match_id} — ${m.state}.`,b?`Your pick: ${b.pick.toUpperCase()} · stake ${b.stake} · ${b.status}.`:"You have no bet on this market.",`Available balance: ${account.balance.toLocaleString("en-US")}.`];
      if(m.settlement_version)lines.push(`Total credited for this match: ${(m.paidCredits[user]||0).toLocaleString("en-US")}.`);
      const components=[];
      if(isOpen(m,ctx.now))components.push(new ActionRowBuilder().addComponents(...["blue","red","tie"].map(p=>new ButtonBuilder().setCustomId(`pred:pick:${m.id}:${m.revision}:${p}`).setLabel(`Change to ${p}`).setStyle(ButtonStyle.Secondary)),new ButtonBuilder().setCustomId(`pred:cancel:${m.id}:${m.revision}`).setLabel("Cancel Bet").setStyle(ButtonStyle.Danger)));
      await privateReply(i,{content:lines.join("\n"),components});
    }else throw new Error("Unknown prediction control");
  }catch(error){
    // Do not expose SQL, payloads or financial history through exception strings.
    const safe=/^(Stale|Invalid|Predictions|Match participant|Insufficient funds|Stake|Operation conflict|Confirmation expired|State changed|Only the configured|Correction no longer)/.test(error.message)?error.message:"Prediction action could not be completed. Check My Bet before retrying.";
    try{await privateReply(i,safe);}catch{service.logger.warn?.("[predictions] private response unavailable");}
  }
  return true;
}
module.exports={handleInteraction,privateReply};
