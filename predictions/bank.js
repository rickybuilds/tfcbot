"use strict";
const {sendAuditLog}=require("../lib/auditLog");
const points=value=>BigInt(value).toLocaleString("en-US");
const signed=value=>`${value>=0n?"+":""}${points(value)}`;
function credited(store,marketId,user){
  return store.db.prepare("SELECT amount FROM prediction_transactions WHERE market_id=? AND account_id=? AND kind IN ('settlement','correction')").all(marketId,user).reduce((total,row)=>total+BigInt(row.amount),0n);
}
function buildStatement(service,user){
  const store=service.store;
  return store.atomic(()=>{
    const account=store.ensureAccount(user,service.context("bank",user));
    const held=store.db.prepare("SELECT stake FROM prediction_bets WHERE discord_id=? AND status='active'").all(user).reduce((total,row)=>total+BigInt(row.stake),0n);
    const progress=store.bettingProgress(user);
    const bets=store.db.prepare(`SELECT b.*,m.match_id,m.revision,m.state,m.closes_at,
      json_extract(m.snapshot,'$.mapName') AS map_name FROM prediction_bets b
      JOIN prediction_markets m ON m.id=b.market_id WHERE b.discord_id=? ORDER BY b.created_at DESC,b.id DESC LIMIT 5`).all(user);
    const betLines=bets.map(b=>{
      let result;
      if(b.status==="settled"){
        const returned=credited(store,b.market_id,user);
        result=`returned ${points(returned)} (net ${signed(returned-BigInt(b.stake))}); ${b.state==="review_required"?"result under review":"settled"}`;
      }else if(b.status==="cancelled")result=`cancelled; refunded ${points(b.stake)}`;
      else if(b.status==="refunded")result=`refunded ${points(b.stake)}`;
      else result=`held; ${b.state==="review_required"?"under review":b.state==="closed"||(b.closes_at!=null&&service.clock()>=b.closes_at)?"betting closed":"betting open"}`;
      return `\`${b.match_id}\` (${b.map_name}, rev ${b.revision}) · ${b.pick.toUpperCase()} · stake ${points(b.stake)} · ${result}`;
    });
    const played=store.db.prepare(`SELECT m.* FROM prediction_markets m WHERE m.settlement_version>0 AND (
      EXISTS(SELECT 1 FROM json_each(m.snapshot,'$.blueIds') WHERE value=?) OR
      EXISTS(SELECT 1 FROM json_each(m.snapshot,'$.redIds') WHERE value=?))
      ORDER BY COALESCE((SELECT MIN(t.created_at) FROM prediction_transactions t WHERE t.market_id=m.id AND t.kind='allocation' AND t.settlement_version=1),m.closed_at,m.opened_at) DESC,m.id DESC LIMIT 5`).all(user,user);
    const playerLines=played.map(m=>{
      const snapshot=JSON.parse(m.snapshot),team=snapshot.blueIds.includes(user)?"BLUE":"RED";
      return `\`${m.match_id}\` (${snapshot.mapName}) · ${team} · ${signed(credited(store,m.id,user))} points received${m.state==="review_required"?"; result under review":""}`;
    });
    return ["🏦 **Your prediction bank**",
      `Available: **${points(account.balance)} points**`,
      `Held in active bets: **${points(held)} points**`,
      `Total points: **${points(BigInt(account.balance)+held)}**`,
      `Bet limit: **${points(progress.limit)} points** · ${progress.settledGames} settled games bet on`,
      "", "🎲 **Last 5 bets**",betLines.join("\n")||"No bets yet.",
      "", "🎮 **Last 5 settled games played — player rewards**",playerLines.join("\n")||"No settled prediction games played yet.",
      "", "Returns include your stake; net is profit/loss. Player rewards are separate. Points are separate from ELO."].join("\n");
  });
}
async function handleBankCommand(service,message,command="bank"){
  if(message.guild){try{await message.delete();}catch{service.logger.warn?.("[predictions] bank command cleanup failed");}}
  let payload;
  try{
    const text=buildStatement(service,String(message.author.id));
    payload=text.length<=1900?{content:text,allowedMentions:{parse:[]}}:{content:"Your private prediction bank statement.",files:[{attachment:Buffer.from(text),name:"prediction-bank.txt"}],allowedMentions:{parse:[]}};
  }catch{
    service.logger.warn?.("[predictions] bank statement could not be loaded");
    payload={content:"Your statement could not be loaded. Please try again shortly."};
  }
  try{await message.author.send(payload);}catch{
    service.logger.warn?.("[predictions] bank DM unavailable");
    if(message.guild)try{await message.channel.send({content:"I couldn't DM your statement. Enable DMs from server members and try !bank or !points again.",allowedMentions:{parse:[]}});}catch{}
  }
  await sendAuditLog({
    client:message.client||service.client,
    guild:message.guild,
    channelId:service.config.channels?.audit,
    payload:{content:`🏦 <@${message.author.id}> ran \`!${command==="points"?"points":"bank"}\` in **${message.guild?.name||"DM"}** at <t:${Math.floor(service.clock()/1000)}:T>`,allowedMentions:{parse:[]}},
  });
}
function register(registry,service){
  for(const command of ["bank","points"])registry.set(command,message=>service.handleBankCommand(message,command));
}
module.exports={handleBankCommand,register};
