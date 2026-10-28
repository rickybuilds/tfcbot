"use strict";
const {initializeSchema}=require("./schema");
const {calculatePayouts}=require("./payouts");
const decode=row=>row?{...row,snapshot:JSON.parse(row.snapshot),paidCredits:JSON.parse(row.paid_credits)}:null;
function validSnapshot(s) {
  const ids=[...s.blueIds,...s.redIds];
  if(s.blueIds.length!==4||s.redIds.length!==4||new Set(ids).size!==8||!s.matchId||!s.serverKey||!s.mapName)throw new Error("Invalid official roster");
  return {...s,blueIds:s.blueIds.map(String),redIds:s.redIds.map(String),offenseIds:(s.offenseIds||[]).map(String)};
}
class PredictionStore {
  constructor(db) { this.db=db;initializeSchema(db); }
  atomic(fn) {return this.db.inTransaction?fn():this.db.transaction(fn).immediate();}
  account(id) {return this.db.prepare("SELECT * FROM prediction_accounts WHERE discord_id=?").get(String(id));}
  market(id) {return decode(this.db.prepare("SELECT * FROM prediction_markets WHERE id=?").get(id));}
  latest(id) {return decode(this.db.prepare("SELECT * FROM prediction_markets WHERE match_id=? ORDER BY revision DESC LIMIT 1").get(String(id)));}
  markets() {return this.db.prepare("SELECT * FROM prediction_markets ORDER BY id").all().map(decode);}
  bets(id) {return this.db.prepare("SELECT * FROM prediction_bets WHERE market_id=?").all(id);}
  bettingProgress(id) {
    const {games}=this.db.prepare(`SELECT COUNT(DISTINCT m.match_id) AS games FROM prediction_bets b
      JOIN prediction_markets m ON m.id=b.market_id WHERE b.discord_id=? AND b.status='settled' AND m.settlement_version>0`).get(String(id));
    const limit=100+10*Math.min(games,40);
    if(!Number.isSafeInteger(limit))throw new Error("Unsafe stake limit");
    return {settledGames:games,limit};
  }
  stakeLimit(m,id) {return m.rule_version===1?250:this.bettingProgress(id).limit;}
  metadata(key,fallback=null) {return this.db.prepare("SELECT value FROM prediction_meta WHERE key=?").get(key)?.value??fallback;}
  setMetadata(key,value) {this.db.prepare("INSERT INTO prediction_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,String(value));}
  entry(ctx,{accountId=null,amount=0,kind,marketId=null,betId=null,entryKey,version=null,metadata=null}) {
    this.db.prepare(`INSERT INTO prediction_transactions (account_id,amount,kind,market_id,bet_id,operation_key,entry_key,actor_id,reason,settlement_version,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(accountId,amount,kind,marketId,betId,ctx.operationKey,entryKey,String(ctx.actorId),ctx.reason||null,version,metadata?JSON.stringify(metadata):null,ctx.now);
  }
  operation(ctx,scope,fn) {
    if(!ctx?.operationKey||!ctx.actorId||!Number.isSafeInteger(ctx.now))throw new Error("Invalid operation context");
    return this.atomic(()=>{
      const row=this.db.prepare("SELECT metadata,actor_id FROM prediction_transactions WHERE operation_key=? AND entry_key='result'").get(ctx.operationKey);
      if(row){const old=JSON.parse(row.metadata);if(old.scope!==scope||row.actor_id!==String(ctx.actorId))throw new Error("Operation conflict");return old.result;}
      const result=fn();this.entry(ctx,{kind:"operation",entryKey:"result",metadata:{scope,result}});return result;
    });
  }
  ensureAccount(id,ctx) {
    id=String(id);
    return this.atomic(()=>{
      if(!this.account(id)){
        this.db.prepare("INSERT INTO prediction_accounts VALUES (?,?,?,?)").run(id,1000,ctx.now,ctx.now);
        this.entry({...ctx,operationKey:`grant:${id}`},{accountId:id,amount:1000,kind:"grant",entryKey:"grant"});
      }
      return this.account(id);
    });
  }
  change(id,amount,ctx,details) {
    if(!Number.isSafeInteger(amount))throw new Error("Unsafe amount");
    this.ensureAccount(id,ctx);
    const n=this.db.prepare("UPDATE prediction_accounts SET balance=balance+?,updated_at=? WHERE discord_id=? AND balance+? BETWEEN 0 AND 9007199254740991").run(amount,ctx.now,String(id),amount);
    if(!n.changes)throw new Error("Insufficient funds or unsafe balance");
    this.entry(ctx,{...details,accountId:String(id),amount});
  }
  createMarket(snapshot,ctx,ruleVersion=3) {
    const s=validSnapshot(snapshot);
    return this.atomic(()=>{
      const old=this.latest(s.matchId);
      if(old&&old.state!=="void"){
        if(old.state==="settled")throw new Error("Historical match ID cannot be reused");
        if(JSON.stringify(old.snapshot)===JSON.stringify(s))return old;
        throw new Error("Resolve previous market first");
      }
      if(!old&&ruleVersion>=4)require("./payouts").multipliers(s.eloOdds);
      const row=this.db.prepare("INSERT INTO prediction_markets (match_id,revision,state,snapshot,opened_at,rule_version) VALUES (?,?,'open',?,?,?)").run(String(s.matchId),(old?.revision||0)+1,JSON.stringify(s),ctx.now,old?.rule_version||ruleVersion);
      return this.market(Number(row.lastInsertRowid));
    });
  }
  mutable(ref,now) {
    const m=this.market(ref.marketId);
    if(!m||m.revision!==ref.revision)throw new Error("Stale prediction market");
    if(!["open","countdown"].includes(m.state)||(m.closes_at!=null&&now>=m.closes_at))throw new Error("Predictions closed");
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get()){
      const official=this.db.prepare("SELECT status FROM matches WHERE match_id=?").get(m.match_id);
      if(official&&String(official.status).toLowerCase()==="completed")throw new Error("Predictions closed; official match already completed");
    }
    return m;
  }
  placeBet({marketRef,discordId,pick,stake,context:ctx}) {
    return this.operation(ctx,`bet:${marketRef.marketId}:${discordId}:${pick}:${stake}`,()=>{
      const m=this.mutable(marketRef,ctx.now),id=String(discordId);
      if(this.metadata("paused","0")==="1")throw new Error("Predictions paused");
      const limit=this.stakeLimit(m,id);
      if(!["blue","red","tie"].includes(pick)||!Number.isSafeInteger(stake)||stake<1||stake>limit)throw new Error(`Stake must be a whole number from 1 to ${limit.toLocaleString("en-US")}`);
      const participant=this.markets().filter(x=>x.match_id===m.match_id).some(x=>[...x.snapshot.blueIds,...x.snapshot.redIds,...x.snapshot.offenseIds].includes(id));
      if(participant)throw new Error("Match participant cannot bet");
      const old=this.bets(m.id).find(b=>b.discord_id===id);
      const total=this.bets(m.id).filter(b=>b.status==="active"&&b.discord_id!==id).reduce((n,b)=>n+BigInt(b.stake),BigInt(stake));
      if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Stake would exceed the safe game total");
      this.change(id,(old?.status==="active"?old.stake:0)-stake,ctx,{kind:"stake",marketId:m.id,entryKey:"stake"});
      this.db.prepare(`INSERT INTO prediction_bets (market_id,discord_id,pick,stake,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?) ON CONFLICT(market_id,discord_id) DO UPDATE SET pick=excluded.pick,stake=excluded.stake,status='active',updated_at=excluded.updated_at`).run(m.id,id,pick,stake,ctx.now,ctx.now);
      return {marketId:m.id,pick,stake,balance:this.account(id).balance};
    });
  }
  cancelBet({marketRef,discordId,context:ctx}) {
    return this.operation(ctx,`cancel:${marketRef.marketId}:${discordId}`,()=>{
      const m=this.mutable(marketRef,ctx.now),b=this.bets(m.id).find(b=>b.discord_id===String(discordId)&&b.status==="active");
      if(b){this.change(discordId,b.stake,ctx,{kind:"cancel",marketId:m.id,entryKey:"cancel"});this.db.prepare("UPDATE prediction_bets SET status='cancelled',updated_at=? WHERE id=?").run(ctx.now,b.id);}
      return {cancelled:!!b,balance:this.ensureAccount(discordId,ctx).balance};
    });
  }
  startCountdown(id,now) {this.db.prepare("UPDATE prediction_markets SET state='countdown',closes_at=? WHERE id=? AND state='open' AND closes_at IS NULL").run(now+120000,id);return this.market(id);}
  closeMarket(id,ctx) {this.db.prepare("UPDATE prediction_markets SET state='closed',closed_at=? WHERE id=? AND state IN ('open','countdown')").run(ctx.now,id);return this.market(id);}
  markReview(id,reason) {this.db.prepare("UPDATE prediction_markets SET state='review_required',reason=? WHERE id=? AND state!='void'").run(reason,id);}
  voidMarket({marketId,context:ctx}) {
    return this.operation(ctx,`void:${marketId}`,()=>{
      const m=this.market(marketId);if(!m)throw new Error("Unknown market");
      if(m.settlement_version>0)throw new Error("Settled market requires owner correction");
      for(const b of this.bets(marketId).filter(b=>b.status==="active"))this.change(b.discord_id,b.stake,ctx,{kind:"refund",marketId,betId:b.id,entryKey:`refund:${b.id}`});
      this.db.prepare("UPDATE prediction_bets SET status='refunded',updated_at=? WHERE market_id=? AND status='active'").run(ctx.now,marketId);
      this.db.prepare("UPDATE prediction_markets SET state='void',reason=? WHERE id=?").run(ctx.reason||"terms changed",marketId);
      return {void:true};
    });
  }
  settleMarket({marketId,outcome,context:ctx}) {return this.settle(marketId,outcome,ctx,false);}
  settleReviewedMarket({marketId,outcome,context:ctx,mapChange=null,teamChange=null}) {
    return this.operation(ctx,`owner-settle:${marketId}:${outcome}`,()=>{
      const m=this.market(marketId);
      if(!ctx.reason||!m||m.state!=="review_required"||m.settlement_version)throw new Error("Owner settlement requires a reason and an unsettled reviewed game");
      this.entry(ctx,{kind:"owner_settlement",marketId,entryKey:"owner-settlement",metadata:{outcome,previousState:m.state,reviewReason:m.reason,originalDeadline:m.closes_at,revision:m.revision,snapshot:m.snapshot,mapChange,teamChange}});
      this.db.prepare("UPDATE prediction_markets SET state='closed',closed_at=COALESCE(closed_at,?),reason=NULL WHERE id=?").run(ctx.now,marketId);
      return this.settleMarket({marketId,outcome,context:{...ctx,operationKey:`${ctx.operationKey}:payout`}});
    });
  }
  correctSettlement({marketId,outcome,context:ctx}) {return this.settle(marketId,outcome,ctx,true);}
  settle(id,outcome,ctx,correction) {
    return this.operation(ctx,`${correction?"correct":"settle"}:${id}:${outcome}`,()=>{
      const m=this.market(id);if(!m)throw new Error("Unknown market");
      if(m.result===outcome&&m.settlement_version>0&&m.state==="settled")return {version:m.settlement_version,duplicate:true};
      if(correction&&!ctx.reason)throw new Error("Correction reason required");
      if(correction?m.settlement_version<1:m.state!=="closed")throw new Error("Market is not eligible for settlement");
      const bets=this.bets(id).filter(b=>b.status==="active"||b.status==="settled");
      const allocation=calculatePayouts({bets,outcome,...m.snapshot,ruleVersion:m.rule_version}),paid={...m.paidCredits};
      const version=m.settlement_version+1;let house=0;
      for(const [user,entitlement] of Object.entries(allocation.credits)){
        const amount=Math.max(0,entitlement-(paid[user]||0));
        if(amount){this.change(user,amount,ctx,{kind:correction?"correction":"settlement",marketId:id,version,entryKey:`credit:${user}`});paid[user]=(paid[user]||0)+amount;house+=amount;}
      }
      const funding=correction?house:(allocation.houseFunding||0);
      if(funding)this.entry(ctx,{kind:"house_funding",amount:funding,marketId:id,version,entryKey:"house"});
      // Stakes already left bettor balances. Record their destination once;
      // corrections retain prior distributions and use audited house funding.
      if(!correction&&allocation.houseTake)this.entry(ctx,{kind:"house_collection",amount:allocation.houseTake,marketId:id,version,entryKey:"house-collection"});
      this.entry(ctx,{kind:"allocation",marketId:id,version,entryKey:"allocation",metadata:{outcome,allocation,paidCredits:paid,houseFunding:funding}});
      this.db.prepare("UPDATE prediction_bets SET status='settled',updated_at=? WHERE market_id=? AND status='active'").run(ctx.now,id);
      this.db.prepare("UPDATE prediction_markets SET state='settled',result=?,observed_result=?,settlement_version=?,allocation=?,paid_credits=? WHERE id=?").run(outcome,outcome,version,JSON.stringify(allocation),JSON.stringify(paid),id);
      return {version,houseFunding:funding};
    });
  }
  adjust(id,amount,ctx) {
    if(!ctx.reason||!Number.isSafeInteger(amount)||!amount)throw new Error("Adjustment requires a safe integer and reason");
    return this.operation(ctx,`adjust:${id}:${amount}`,()=>{this.change(id,amount,ctx,{kind:"adjustment",entryKey:"adjustment"});return this.account(id);});
  }
  houseFunding() {return this.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM prediction_transactions WHERE kind='house_funding'").get().n;}
  assertAccounting() {
    // Each persisted amount is an integer, but totals can exceed both JS's safe
    // number range and SQLite SUM's signed 64-bit range. Sum individual rows.
    let balance=0n,escrow=0n,issued=0n;
    const accounts=new Map(),histories=new Map();
    for(const row of this.db.prepare("SELECT discord_id,balance FROM prediction_accounts").safeIntegers(true).iterate()){
      accounts.set(row.discord_id,row.balance);balance+=row.balance;
    }
    for(const row of this.db.prepare("SELECT stake FROM prediction_bets WHERE status='active'").safeIntegers(true).iterate())escrow+=row.stake;
    for(const row of this.db.prepare("SELECT account_id,amount,kind FROM prediction_transactions").safeIntegers(true).iterate()){
      if(["grant","adjustment","house_funding"].includes(row.kind))issued+=row.amount;
      if(row.kind==="house_collection")issued-=row.amount;
      if(accounts.has(row.account_id))histories.set(row.account_id,(histories.get(row.account_id)||0n)+row.amount);
    }
    if(balance+escrow!==issued)throw new Error("Prediction accounting invariant failed");
    for(const [id,amount] of accounts)if(amount!==(histories.get(id)||0n))throw new Error("Account history mismatch");
    return true;
  }
}
module.exports={PredictionStore,validSnapshot};
