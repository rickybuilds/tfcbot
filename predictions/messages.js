"use strict";
const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
function isOpen(m,now) {return ["open","countdown"].includes(m.state)&&(m.closes_at==null||now<m.closes_at);}
function statusText(m) {
  if(m.state==="open")return "Predictions open — closes 2 minutes after all 8 roster players are on the assigned server with the voted map loaded.";
  if(m.state==="countdown")return `Predictions close <t:${Math.floor(m.closes_at/1000)}:R> (<t:${Math.floor(m.closes_at/1000)}:T>).`;
  if(m.state==="settled")return `Predictions settled — official result: ${String(m.result).toUpperCase()}. Use My Bet for your private result.`;
  if(m.state==="review_required")return "Predictions frozen for owner review.";
  return m.state==="void"?"Predictions voided — stakes refunded.":"Predictions closed — waiting for the official result.";
}
function actionRow(m,now) {
  const odds=m.snapshot?.eloOdds;
  const validOdds=odds&&[odds.blue,odds.red].every(n=>Number.isInteger(n)&&n>=0&&n<=100)&&odds.blue+odds.red===100;
  const rates=m.rule_version>=4?require("./payouts").multipliers(odds):null;
  const labels=[`Blue / Team 1${validOdds?` · ${odds.blue}%`:""}${rates?` · ${(rates.blue/100).toFixed(2)}x`:""}`,`Red / Team 2${validOdds?` · ${odds.red}%`:""}${rates?` · ${(rates.red/100).toFixed(2)}x`:""}`,`Tie${rates?" · 2.00x":""}`];
  const buttons=[...["blue","red","tie"].map((pick,i)=>new ButtonBuilder().setCustomId(`pred:pick:${m.id}:${m.revision}:${pick}`).setLabel(labels[i]).setStyle([ButtonStyle.Primary,ButtonStyle.Danger,ButtonStyle.Secondary][i]).setDisabled(!isOpen(m,now))),new ButtonBuilder().setCustomId(`pred:mine:${m.id}:${m.revision}`).setLabel("My Bet").setStyle(ButtonStyle.Secondary)];
  return new ActionRowBuilder().addComponents(buttons);
}
function cardUpdate(m,now=Date.now()) {
  const rule=m.rule_version>=4?" Returns include your stake; losing bets are not refunded. Players receive fixed rewards.":m.rule_version>=3?" If nobody picks the official result, the house keeps the pot; losing bets are not refunded.":"";
  return {content:statusText(m)+rule,components:[actionRow(m,now)]};
}
module.exports={cardUpdate,actionRow,statusText,isOpen};
