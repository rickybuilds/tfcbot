"use strict";
const {randomUUID}=require("node:crypto");
const {ActionRowBuilder,ButtonBuilder,ButtonStyle}=require("discord.js");
const {privateReply}=require("./interactions");
function assertOwner(service,id) {if(!service.config.predictionsOwnerId||String(id)!==service.config.predictionsOwnerId)throw new Error("Only the configured prediction owner can use financial controls");}
function official(service,matchId) {
  const row=service.db.prepare("SELECT winner,status FROM matches WHERE match_id=?").get(String(matchId));
  return row&&String(row.status).toLowerCase()==="completed"?String(row.winner).toLowerCase():null;
}
function signature(service,p) {
  if(p.action==="adjust")return JSON.stringify(service.store.account(p.target)||null);
  if(["pause","resume"].includes(p.action))return service.store.metadata("paused","0");
  const m=service.store.latest(p.target);
  return JSON.stringify(m?[m.id,m.revision,m.state,m.settlement_version,m.observed_result,m.result,m.deletion_authorized,m.closes_at,officialIfAvailable(service,p.target)]:null);
}
function officialIfAvailable(service,id) {return service.db.prepare("SELECT 1 FROM sqlite_master WHERE name='matches'").get()?official(service,id):null;}
function parse(service,args) {
  const [action,target,third,...rest]=args;
  if(!["void","correct","adjust","pause","resume","retain"].includes(action))throw new Error("Use !pred status/audit/void/correct/adjust/pause/resume/retain");
  const p={action,target};
  if(action==="adjust"){
    p.target=String(target||"").replace(/^<@!?(\d+)>$/,"$1");
    if(!p.target||!/^[-+]?\d+$/.test(third||"")||!Number.isSafeInteger(Number(third))||!Number(third))throw new Error("Adjustment requires a user, nonzero safe integer and reason");
    p.amount=Number(third);p.reason=rest.join(" ");
  }else if(action==="correct"){
    p.outcome=third;p.reason=rest.join(" ");
    if(!["blue","red","tie"].includes(p.outcome)||official(service,target)!==p.outcome)throw new Error("Correction must match the completed official result; fix the match report first");
  }else if(action==="pause"||action==="resume")p.reason=args.slice(1).join(" ");
  else p.reason=args.slice(2).join(" ");
  if(!p.reason?.trim())throw new Error("A reason is required");
  if(!["adjust","pause","resume"].includes(action)&&!service.store.latest(target))throw new Error("Unknown prediction match");
  if(action==="correct"&&!service.store.latest(target).settlement_version)throw new Error("No previous settlement; void the reviewed market instead");
  if(action==="retain"&&!service.store.latest(target).settlement_version)throw new Error("Only settled history can be retained for deletion; void unresolved markets first");
  return p;
}
async function sendPrivate(message,payload) {try{await message.author.send(payload);}catch{/* Never fall back to public financial output. */}}
async function handleAdminCommand(service,message,args=[]) {
  try{
    assertOwner(service,message.author.id);
    const [action,target]=args;
    if(action==="status"){
      const m=service.store.latest(target);if(!m)throw new Error("Unknown prediction match");
      await sendPrivate(message,{content:`${m.match_id} market ${m.id}, revision ${m.revision}: ${m.state}; phase ${m.phase}; deadline ${m.closes_at||"not started"}; settlement ${m.settlement_version}; ${m.reason||"no review reason"}.`});return;
    }
    if(action==="audit"){
      const m=service.store.latest(target);
      const markets=m?service.store.markets().filter(x=>x.match_id===m.match_id):[];
      const rows=m?service.db.prepare("SELECT * FROM prediction_transactions WHERE market_id IN (SELECT id FROM prediction_markets WHERE match_id=?) ORDER BY id").all(m.match_id):service.db.prepare("SELECT * FROM prediction_transactions WHERE account_id=? ORDER BY id").all(String(target));
      await sendPrivate(message,{content:"Private prediction audit.",files:[{attachment:Buffer.from(JSON.stringify({markets,transactions:rows},null,2)),name:"prediction-audit.txt"}]});return;
    }
    const payload=parse(service,args),ctx={operationKey:`preview:${message.id||randomUUID()}`,actorId:String(message.author.id),now:service.clock(),reason:payload.reason};
    const preview=service.store.operation(ctx,"owner-preview",()=>{
      const p={...payload,ownerId:ctx.actorId,expiresAt:ctx.now+60000,signature:signature(service,payload),token:randomUUID()};
      service.store.entry(ctx,{kind:"preview",entryKey:"preview",metadata:p});return p;
    });
    await sendPrivate(message,{content:`Confirm ${preview.action} ${preview.target||""}${preview.amount!=null?` ${preview.amount}`:""}${preview.outcome?` → ${preview.outcome}`:""}.\nReason: ${preview.reason}\nExpires in 60 seconds.${preview.action==="correct"?" Prior payouts remain untouched; the house funds additional entitlements.":""}`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`pred:confirm:${preview.token}`).setLabel("Confirm").setStyle(ButtonStyle.Danger))]});
  }catch(error){await sendPrivate(message,{content:error.message});}
}
async function confirm(service,i,token) {
  assertOwner(service,i.user.id);
  const row=service.db.prepare("SELECT metadata FROM prediction_transactions WHERE kind='preview' AND json_extract(metadata,'$.token')=?").get(token);
  if(!row)throw new Error("Invalid confirmation");
  const p=JSON.parse(row.metadata);if(p.ownerId!==String(i.user.id))throw new Error("Invalid confirmation owner");
  const ctx={operationKey:`confirmation:${token}`,actorId:String(i.user.id),reason:p.reason,now:service.clock()};
  const result=service.store.operation(ctx,`owner:${token}`,()=>{
    if(ctx.now>=p.expiresAt)throw new Error("Confirmation expired; request a new preview");
    if(signature(service,p)!==p.signature)throw new Error("State changed; request a new preview");
    const m=service.store.latest(p.target),inner={...ctx,operationKey:`${ctx.operationKey}:action`};
    if(p.action==="adjust")service.store.adjust(p.target,p.amount,inner);
    if(p.action==="void")service.store.voidMarket({marketId:m.id,context:inner});
    if(p.action==="correct"){
      if(official(service,p.target)!==p.outcome)throw new Error("Correction no longer matches official result");
      service.store.correctSettlement({marketId:m.id,outcome:p.outcome,context:inner});
    }
    if(p.action==="retain"){
      service.db.prepare("UPDATE prediction_markets SET deletion_authorized=1 WHERE match_id=?").run(p.target);
      service.store.entry(inner,{kind:"retain_history",entryKey:"retain",marketId:m.id});
    }
    if(p.action==="pause"||p.action==="resume"){
      service.store.setMetadata("paused",p.action==="pause"?"1":"0");service.store.entry(inner,{kind:p.action,entryKey:"pause"});
    }
    return {content:`Owner action completed: ${p.action}.`};
  });
  await privateReply(i,result);
  const m=service.store.latest(p.target);if(m)service.refreshCard(m.id);
}
module.exports={handleAdminCommand,confirm};
