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
  const labels=[`Blue / Team 1${validOdds?` · ${odds.blue}%`:""}`,`Red / Team 2${validOdds?` · ${odds.red}%`:""}`,"Tie"];
  const buttons=[...["blue","red","tie"].map((pick,i)=>new ButtonBuilder().setCustomId(`pred:pick:${m.id}:${m.revision}:${pick}`).setLabel(labels[i]).setStyle([ButtonStyle.Primary,ButtonStyle.Danger,ButtonStyle.Secondary][i]).setDisabled(!isOpen(m,now))),new ButtonBuilder().setCustomId(`pred:mine:${m.id}:${m.revision}`).setLabel("My Bet").setStyle(ButtonStyle.Secondary)];
  return new ActionRowBuilder().addComponents(buttons);
}
function cardUpdate(m,now=Date.now()) {return {content:statusText(m),components:[actionRow(m,now)]};}
module.exports={cardUpdate,actionRow,statusText,isOpen};
