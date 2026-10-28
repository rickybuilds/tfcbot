"use strict";
const {randomUUID,createHash}=require("node:crypto");
const {PredictionStore,validSnapshot}=require("./store");
const {PresenceTracker,rosterPresence,parseStatus,normalizeSteamId}=require("./presence");
const {sameMap,officialTermsMismatch,acceptedMapChange,acceptedTeamChange}=require("./official");
const recoverableReviews=new Set(["unexpected server map","server monitoring unavailable","restart: connection/terms history requires owner review","completed official report awaiting settlement"]);
function termsKey(s) {
  return JSON.stringify([s.blueIds.slice().sort(),s.redIds.slice().sort(),(s.offenseIds||[]).slice().sort(),s.serverKey,s.mapName,s.team1Starts]);
}
function rosterFailureReason(error) {
  // Fixed labels only: exception text may contain raw responses or secrets.
  const message=String(error?.message||"");
  if(/^Incomplete (?:server status (?:roster|player)|roster)$/.test(message))return "incomplete status roster";
  if(message==="Roster changed during query")return "roster changed during query";
  if(/timeout/i.test(message))return "RCON timeout";
  return /ECONNREFUSED/.test(message)?"RCON connection refused":"RCON/status query failed";
}
class PredictionsService {
  constructor({db,client,config={},clock=Date.now,logger=console,queryServerRoster,queryServerPhase,waitForRosterRetry}) {
    this.store=new PredictionStore(db);this.db=db;this.client=client;this.config=config;this.clock=clock;this.logger=logger;
    this.presence=new PresenceTracker();this.knownServers=new Set();this.inflight=new Map();this.cardJobs=new Map();this.timer=null;
    this.queryServerRoster=queryServerRoster|| (async serverKey=>parseStatus(await require("../services/rconClient").runRawRconCommand(serverKey,"status")));
    this.queryServerPhase=queryServerPhase||require("./phase").queryServerPhase;
    this.waitForRosterRetry=waitForRosterRetry||(()=>new Promise(resolve=>setTimeout(resolve,2000)));
    this.rosterSchedules=new Map();
  }
  context(prefix="system",actorId="system",reason) {return {operationKey:`${prefix}:${randomUUID()}`,actorId,reason,now:this.clock()};}
  snapshotWithOdds(snapshot) {
    const {getRating,summarizeSplit}=require("../lib/odds");
    const blue=snapshot.blueIds.map(id=>({id:String(id)})),red=snapshot.redIds.map(id=>({id:String(id)}));
    const ratings=new Map([...blue,...red].map(player=>[player.id,getRating({db:this.db},player)]));
    const odds=summarizeSplit(blue,red,ratings);
    return {...snapshot,eloOdds:{blue:odds.pctBlue,red:odds.pctRed}};
  }
  snapshotFromRow(row,overrides={}) {
    const parse=(s,fallback)=>{try{return JSON.parse(s||"null")||fallback;}catch{return fallback;}};
    const blueIds=parse(row.blue_ids,[]).map(String),redIds=parse(row.red_ids,[]).map(String),offense=parse(row.offense_ids,{});
    const steamIdsByDiscordId={};
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='player_steam_ids'").get()) for(const id of [...blueIds,...redIds])steamIdsByDiscordId[id]=this.db.prepare("SELECT steam_id FROM player_steam_ids WHERE discord_id=?").all(id).map(r=>r.steam_id);
    return {matchId:String(row.match_id),blueIds,redIds,offenseIds:[...(offense.blue||[]),...(offense.red||[])].map(String),steamIdsByDiscordId,serverKey:require("../services/autoRecap").determineServerKey(row.server_name),mapName:row.map_name,team1Starts:this.store.latest(row.match_id)?.snapshot.team1Starts||"offense",...overrides};
  }
  onMatchFinalized(snapshot,context=this.context("finalize")) {
    if(!this.config.predictionsEnabled)return null;
    validSnapshot(snapshot);
    if(this.store.latest(snapshot.matchId)?.state==="void")throw new Error("Historical match ID cannot be reused after a void");
    const active=this.store.markets().filter(m=>m.snapshot.serverKey===snapshot.serverKey&&m.match_id!==String(snapshot.matchId)&&!["void","settled"].includes(m.state));
    const hasMatches=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get();
    for(const previous of active){
      const official=hasMatches&&this.db.prepare("SELECT status FROM matches WHERE match_id=?").get(previous.match_id);
      if(!official||String(official.status).toLowerCase()!=="completed")throw new Error("Assigned server already has an unresolved prediction market");
      // A completed game's financial history cannot reserve the game server.
      // Stop any stale controls while its independent result retry catches up.
      if(["open","countdown"].includes(previous.state))this.store.markReview(previous.id,"completed official report awaiting settlement");
    }
    const market=this.store.createMarket(this.snapshotWithOdds(snapshot),context,4);
    this.rosterSchedules.delete(snapshot.serverKey);
    return market;
  }
  applyRosterChange({matchId,nextSnapshot,applyMatchWrites,context=this.context("terms","system","match terms changed")}) {
    return this.store.atomic(()=>{
      const m=this.store.latest(matchId);
      if(!m){applyMatchWrites();return null;}
      validSnapshot(nextSnapshot);
      if(termsKey(m.snapshot)===termsKey(nextSnapshot)){applyMatchWrites();return m;}
      applyMatchWrites();
      if(m.settlement_version>0){this.store.markReview(m.id,"historical roster/terms change");return this.store.market(m.id);}
      if(m.state==="void")return m;
      if(m.phase==="unknown"||m.state==="review_required"){
        this.store.markReview(m.id,"terms changed with uncertain match phase");return this.store.market(m.id);
      }
      this.store.voidMarket({marketId:m.id,context});
      if(m.phase==="live")return this.store.market(m.id);
      const next=this.store.createMarket(this.snapshotWithOdds(nextSnapshot),context);
      if(m.snapshot.serverKey===nextSnapshot.serverKey&&m.snapshot.mapName===nextSnapshot.mapName)this.db.prepare("UPDATE prediction_markets SET phase_evidence=? WHERE id=?").run(m.phase_evidence,next.id);
      return this.store.market(next.id);
    });
  }
  async prepareTermsChange(matchId) {
    const m=this.store.latest(matchId);if(!m||m.phase==="live"||m.state==="void"||m.settlement_version)return;
    try{
      const previousEvidence=JSON.parse(m.phase_evidence||"{}");
      const evidence=await this.queryServerPhase(m.snapshot.serverKey,m.snapshot.mapName,{anchorLogInstance:previousEvidence.anchorLogInstance,openedAt:m.opened_at});
      // A live event received while the query was in flight always wins.
      const latest=this.store.latest(matchId);if(!latest||latest.phase==="live")return;
      if(latest.snapshot.serverKey!==m.snapshot.serverKey||latest.snapshot.mapName!==m.snapshot.mapName){this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(latest.id);return;}
      const phase=["pregame","live"].includes(evidence.phase)?evidence.phase:"unknown";
      this.db.prepare("UPDATE prediction_markets SET phase=?,phase_evidence=?,live_at=CASE WHEN ?='live' THEN COALESCE(live_at,?) ELSE live_at END WHERE id=?").run(phase,JSON.stringify({...previousEvidence,...evidence,observedAt:this.clock()}),phase,this.clock(),latest.id);
    }catch{this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=? AND phase!='live'").run(m.id);}
  }
  refreshReadinessLinks(id) {
    return this.store.atomic(()=>{
      const m=this.store.market(id);
      if(!m||m.state!=="open"||m.closes_at!=null||!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='player_steam_ids'").get())return m;
      const links={};
      for(const user of [...m.snapshot.blueIds,...m.snapshot.redIds])links[user]=[...new Set(this.db.prepare("SELECT steam_id FROM player_steam_ids WHERE discord_id=?").all(user).map(row=>normalizeSteamId(row.steam_id)).filter(Boolean))].sort();
      if(JSON.stringify(links)===JSON.stringify(m.snapshot.steamIdsByDiscordId))return m;
      const ctx=this.context("readiness-links","system","refresh verified roster links before betting deadline");
      this.store.entry(ctx,{kind:"readiness_links",marketId:m.id,entryKey:"links",metadata:{previous:m.snapshot.steamIdsByDiscordId,current:links}});
      this.db.prepare("UPDATE prediction_markets SET snapshot=? WHERE id=?").run(JSON.stringify({...m.snapshot,steamIdsByDiscordId:links}),m.id);
      return this.store.market(m.id);
    });
  }
  maybeStart(serverKey,authoritative=false) {
    if(!this.knownServers.has(serverKey))return;
    for(const candidate of this.store.markets().filter(m=>m.state==="open"&&m.snapshot.serverKey===serverKey)){
      const m=this.refreshReadinessLinks(candidate.id);
      if(sameMap(this.presence.state(serverKey).mapName,m.snapshot.mapName)&&rosterPresence([...m.snapshot.blueIds,...m.snapshot.redIds],m.snapshot.steamIdsByDiscordId,this.presence.get(serverKey)).allPresent){
        if(!authoritative)return this.reconcileServer(serverKey);
        this.store.startCountdown(m.id,this.clock());this.refreshCard(m.id);
      }
    }
  }
  onRestartRequested({matchId,serverKey}) {
    const m=this.store.latest(matchId);
    if(!m||m.snapshot.serverKey!==serverKey||!["open","countdown"].includes(m.state))return;
    const now=this.clock();
    this.rosterSchedules.set(serverKey,{requestedAt:now,notBefore:now+15000,nextAt:now+15000});
    this.knownServers.delete(serverKey);
    this.presence.beginQuery(serverKey); // Invalidate a response from before the restart.
  }
  rosterCheckDeferred(serverKey) {return this.clock()<(this.rosterSchedules.get(serverKey)?.notBefore||0);}
  async pollRosters() {
    const keys=new Set(this.store.markets().filter(m=>["open","countdown"].includes(m.state)).map(m=>m.snapshot.serverKey));
    await Promise.all([...keys].filter(key=>this.clock()>=(this.rosterSchedules.get(key)?.nextAt||0)).map(key=>this.reconcileServer(key)));
  }
  async reconcileServer(serverKey) {
    if(this.rosterCheckDeferred(serverKey))return;
    if(this.inflight.has(serverKey))return this.inflight.get(serverKey);
    const schedule=this.rosterSchedules.get(serverKey);
    const work=(async()=>{
     for(let attempt=1;attempt<=3;attempt++){
      if(this.rosterCheckDeferred(serverKey))return;
      const token=this.presence.beginQuery(serverKey);
      try{
        const roster=await this.queryServerRoster(serverKey);
        if(!roster.complete)throw new Error("Incomplete roster");
        if(this.rosterCheckDeferred(serverKey))return;
        if(!this.presence.reconcile(serverKey,token,roster))throw new Error("Roster changed during query");
          this.knownServers.add(serverKey);
          for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===serverKey&&["open","countdown"].includes(m.state))){
            const evidence=JSON.parse(m.phase_evidence||"{}");
            if(sameMap(roster.mapName,m.snapshot.mapName))this.db.prepare("UPDATE prediction_markets SET phase_evidence=? WHERE id=?").run(JSON.stringify({...evidence,mapObserved:true}),m.id);
            else if(m.closes_at!=null){this.store.markReview(m.id,"unexpected server map");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);this.refreshCard(m.id);}
          }
          this.maybeStart(serverKey,true);
          return;
      }catch(error){
        this.knownServers.delete(serverKey);
        if(this.rosterCheckDeferred(serverKey))return;
        const reason=rosterFailureReason(error);
        if(attempt<3){
          this.logger.warn?.(`[predictions] roster reconciliation retry for ${serverKey}: ${reason} (attempt ${attempt}/3)`);
          await this.waitForRosterRetry();continue;
        }
        // Bound each query burst, not the lifetime of readiness detection. A
        // later scheduled poll must still be able to confirm the map and eight.
        // An existing persisted deadline remains enforceable during an outage.
        this.logger.warn?.(`[predictions] roster reconciliation failed for ${serverKey}: ${reason}`);
      }
     }
    })();
    this.inflight.set(serverKey,work);try{return await work;}finally{
      this.inflight.delete(serverKey);
      if(this.rosterSchedules.get(serverKey)===schedule){
        const now=this.clock(),twoMinutes=schedule?.requestedAt!=null?schedule.requestedAt+120000:null;
        this.rosterSchedules.set(serverKey,{...schedule,nextAt:twoMinutes!=null?(now<twoMinutes?twoMinutes:now+60000):now+15000});
      }
    }
  }
  onHldsEvent(evt) {
    if(!evt.serverKey)return;
    const previousVersion=this.presence.state(evt.serverKey).version;
    if(this.presence.event(evt)===false)return;
    // Presence rejects stale/out-of-order map packets; they cannot change the
    // market either, or an old lobby packet could freeze a valid countdown.
    if(evt.type==="map"&&this.presence.state(evt.serverKey).version===previousVersion)return;
    for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===evt.serverKey&&!["settled","void"].includes(m.state))){
      const previousEvidence=JSON.parse(m.phase_evidence||"{}");
      // A map warning cannot replace a result/roster/deadline review cause:
      // those causes must never become eligible for automatic recovery.
      if(evt.type==="map"&&!sameMap(evt.name,m.snapshot.mapName)&&m.closes_at!=null&&(m.state!=="review_required"||recoverableReviews.has(m.reason)))this.store.markReview(m.id,"unexpected server map");
      if(evt.type==="map"&&sameMap(evt.name,m.snapshot.mapName)&&m.phase!=="live"){
        const evidence=JSON.parse(m.phase_evidence||"{}");
        this.db.prepare("UPDATE prediction_markets SET phase_evidence=? WHERE id=?").run(JSON.stringify({...evidence,mapObserved:true,...(!evidence.anchorLogInstance&&evt.logInstance?{anchorLogInstance:evt.logInstance,anchorObservedAt:this.clock()}:{})}),m.id);
      }
      if(evt.type==="prediction_live_start"&&sameMap(this.presence.state(evt.serverKey).mapName,m.snapshot.mapName)){
        this.db.prepare("UPDATE prediction_markets SET phase='live',live_at=COALESCE(live_at,?),phase_evidence=? WHERE id=?").run(evt.receivedAt||evt.ts||this.clock(),JSON.stringify({...previousEvidence,sourceTime:evt.sourceTime,logInstance:evt.logInstance,sourceKey:evt.sourceKey}),m.id);
      }
    }
    return this.maybeStart(evt.serverKey);
  }
  tick() {
    for(const m of this.store.markets())if(["open","countdown"].includes(m.state)&&m.closes_at!=null&&this.clock()>=m.closes_at){this.store.closeMarket(m.id,this.context("deadline"));this.refreshCard(m.id);}
  }
  observeOfficialResult({matchId,outcome,context=this.context("result")}) {
    const m=this.store.latest(matchId);if(!m||m.state==="void")return;
    outcome=String(outcome).toLowerCase();if(!["blue","red","tie"].includes(outcome))throw new Error("Invalid official outcome");
    let reason;
    if(!m.settlement_version&&(m.closes_at==null||context.now<m.closes_at))reason="official result received before betting deadline";
    if((m.observed_result&&m.observed_result!==outcome)||(m.result&&m.result!==outcome))reason="official result changed; owner correction required";
    if(reason&&(m.state!=="review_required"||m.reason!==reason))this.store.markReview(m.id,reason);
    if(m.observed_result!==outcome)this.db.prepare("UPDATE prediction_markets SET observed_result=? WHERE id=?").run(outcome,m.id);
  }
  onMatchReported({matchId}) {
    let marketId,changed=false;
    const result=this.store.atomic(()=>{
      const m=this.store.latest(matchId);if(!m||m.state==="void")return;
      const row=this.db.prepare("SELECT * FROM matches WHERE match_id=?").get(String(matchId));
      if(!row||String(row.status).toLowerCase()!=="completed")return;
      const outcome=String(row.winner).toLowerCase();marketId=m.id;
      if(!["blue","red","tie"].includes(outcome)){
        if(m.state!=="review_required"||m.reason!=="invalid completed official result"){this.store.markReview(m.id,"invalid completed official result");changed=true;}
        return;
      }
      const observed=this.context("result");
      if(row.processed_at!=null&&Number.isSafeInteger(Number(row.processed_at)*1000)&&Number(row.processed_at)>=0)observed.now=Number(row.processed_at)*1000;
      this.observeOfficialResult({matchId,outcome,context:observed});
      const current=this.store.market(m.id),now=this.clock();
      changed=current.state!==m.state||current.reason!==m.reason||current.observed_result!==m.observed_result;
      const mismatch=officialTermsMismatch(row,current.snapshot,{allowMapChange:current.settlement_version>0&&acceptedMapChange(this.db,current,row),allowTeamChange:acceptedTeamChange(this.db,current,row)});
      if(mismatch){
        const reason=`official ${mismatch} differ from frozen prediction terms`;
        if(current.state!=="review_required"||current.reason!==reason){this.store.markReview(m.id,reason);changed=true;}
        return;
      }
      if(current.state==="settled"&&current.result===outcome)return {version:current.settlement_version,duplicate:true};
      if(current.state==="review_required"){
        if(current.settlement_version||!recoverableReviews.has(current.reason)||current.closes_at==null||now<current.closes_at)return;
        const ctx=this.context("automatic-recovery","system",current.reason);
        this.store.entry(ctx,{kind:"automatic_recovery",marketId:m.id,entryKey:"recovery",metadata:{reviewReason:current.reason,originalDeadline:current.closes_at,revision:current.revision,outcome}});
        this.db.prepare("UPDATE prediction_markets SET state='closed',closed_at=COALESCE(closed_at,closes_at),reason=NULL WHERE id=?").run(m.id);
      }else if(["open","countdown"].includes(current.state)&&current.closes_at!=null&&now>=current.closes_at){
        this.store.closeMarket(m.id,this.context("deadline"));
      }
      if(this.store.market(m.id).state!=="closed"){
        if(current.state!=="review_required"){this.store.markReview(m.id,"result before betting deadline");changed=true;}
        return;
      }
      const payout=this.store.settleMarket({marketId:m.id,outcome,context:this.context("settle")});changed=true;return payout;
    });
    if(marketId&&changed)this.refreshCard(marketId);
    return result;
  }
  reconcileCompletedMatches() {
    const stats={checked:0,failed:0};
    try{
      if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get())return stats;
      const rows=this.db.prepare("SELECT DISTINCT m.match_id FROM matches m JOIN prediction_markets p ON p.match_id=m.match_id WHERE lower(m.status)='completed' AND p.state!='void'").all();
      for(const row of rows){
        try{this.onMatchReported({matchId:row.match_id});stats.checked++;}
        catch{stats.failed++;this.logger.warn?.("[predictions] official result reconciliation failed; will retry");}
      }
    }catch{stats.failed++;this.logger.warn?.("[predictions] completed match scan unavailable; will retry");}
    return stats;
  }
  async initialize() {
    this.tick();
    for(const m of this.store.markets())if(["open","countdown"].includes(m.state)&&m.closes_at==null){
      this.store.markReview(m.id,"restart: connection/terms history requires owner review");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);
    }
    this.reconcileCompletedMatches();
    this.store.assertAccounting();
    await this.retryPendingCards();
    if(!this.timer){let cycle=0;this.timer=setInterval(()=>{
      try{this.tick();}catch{this.logger.warn?.("[predictions] deadline maintenance unavailable; will retry");}
      Promise.resolve().then(()=>this.pollRosters()).catch(()=>this.logger.warn?.("[predictions] roster scan unavailable; will retry"));
      if(++cycle%15===0){this.reconcileCompletedMatches();Promise.resolve().then(()=>this.retryPendingCards()).catch(()=>this.logger.warn?.("[predictions] card retry unavailable"));}
    },1000);this.timer.unref?.();}
  }
  assertCanDeleteMatch(matchId) {
    const all=this.store.markets().filter(m=>m.match_id===String(matchId));
    if(all.some(m=>m.settlement_version>0&&!m.deletion_authorized))throw new Error("Owner must authorize retaining settled prediction history before deletion");
  }
  applyMatchDeletion({matchId,applyMatchWrites,context=this.context("delete","system","match deleted")}) {
    const dirty=[];
    const result=this.store.atomic(()=>{
      this.assertCanDeleteMatch(matchId);
      for(const m of this.store.markets().filter(m=>m.match_id===String(matchId)&&m.state!=="void"&&!m.settlement_version)){
        this.store.voidMarket({marketId:m.id,context:{...context,operationKey:`${context.operationKey}:${m.id}`}});
        if(m.channel_id){this.store.setMetadata(`card_refresh:${m.id}`,randomUUID());dirty.push(m.id);}
      }
      return applyMatchWrites();
    });
    // Run after synchronous callers have committed, including an enclosing
    // transaction. A rollback removes the durable refresh request as well.
    if(this.client)for(const id of dirty)queueMicrotask(()=>{if(this.store.metadata(`card_refresh:${id}`))this.refreshCard(id);});
    return result;
  }
  bindMessage(id,message) {this.db.prepare("UPDATE prediction_markets SET channel_id=?,message_id=? WHERE id=?").run(String(message.channelId||message.channel?.id),String(message.id),id);}
  queueCardPublication(id,channelId,payload) {
    // Keep destination and original embed together, including inside an outer
    // transaction. A failed pre-send queue must leave no half-published card.
    return this.db.transaction(()=>{
      if(channelId)this.db.prepare("UPDATE prediction_markets SET channel_id=? WHERE id=? AND message_id IS NULL").run(String(channelId),id);
      if(payload){
        const key=`card_payload:${id}`,previous=JSON.parse(this.store.metadata(key,"{}"));
        this.store.setMetadata(key,JSON.stringify({...previous,...payload}));
      }
    })();
  }
  cardPayload(m) {
    const payload=JSON.parse(this.store.metadata(`card_payload:${m.id}`,"{}")),update=require("./messages").cardUpdate(m,this.clock());
    const heading=payload.content?`${payload.content}\n`:payload.embeds?.length?"":`Match ${m.match_id}\nBlue / Team 1: ${m.snapshot.blueIds.map(id=>`<@${id}>`).join(", ")}\nRed / Team 2: ${m.snapshot.redIds.map(id=>`<@${id}>`).join(", ")}\n`;
    return {...payload,...update,content:heading+update.content,allowedMentions:{parse:[]}};
  }
  cardNonce(m) {return createHash("sha256").update(`${m.id}:${m.match_id}:${m.revision}:${m.opened_at}`).digest("hex").slice(0,24);}
  publishCard(id,channel) {
    if(this.cardJobs.has(id))return this.cardJobs.get(id);
    // All publication paths share this job, including initial Match Ready
    // posts. Acquire it before any Discord await or recovery scan can send.
    const job=Promise.resolve().then(async()=>{
      const m=this.store.market(id);if(!m)return;
      if(m.message_id)return this.refreshCard(id);
      if(m.state==="void")return;
      const payload=this.cardPayload(m);
      // Also let Discord deduplicate a recently accepted send whose response
      // was lost. This token stays stable across retries and process restarts.
      const nonce=this.cardNonce(m);
      const message=await channel.send({...payload,nonce,enforceNonce:true});
      this.bindMessage(id,message);
      // A nonce retry can return an earlier accepted message. Refresh the
      // canonical card from current state without delaying match arming.
      this.refreshCard(id);
      return message;
    }).finally(()=>this.cardJobs.delete(id));
    this.cardJobs.set(id,job);
    return job;
  }
  async retryPendingCards() {
    if(!this.client)return;
    for(const row of this.db.prepare("SELECT key FROM prediction_meta WHERE key GLOB 'card_refresh:*'").all())await this.refreshCard(Number(row.key.slice("card_refresh:".length)));
    for(const m of this.store.markets().filter(m=>m.channel_id&&!m.message_id&&m.state!=="void"&&this.store.latest(m.match_id)?.id===m.id)){
      if(this.cardJobs.has(m.id))continue;
      try{
        const channel=await this.client.channels.fetch(m.channel_id);
        await this.publishCard(m.id,channel);
      }catch{this.logger.warn?.(`[predictions] pending card still unavailable for ${m.id}`);}
    }
  }
  async refreshCard(id) {
    try {
    const key=`card_refresh:${id}`,m=this.store.market(id);
    if(!m?.channel_id){this.db.prepare("DELETE FROM prediction_meta WHERE key=?").run(key);return;}
    // Pending publication may bind a message later; retain its refresh request.
    if(!m.message_id)return;
    const token=randomUUID();this.store.setMetadata(key,token);
    if(!this.client)return;
      const channel=await this.client.channels.fetch(m.channel_id),msg=await channel.messages.fetch(m.message_id);
      const update=this.cardPayload(this.store.market(id));
      await msg.edit(update);
      if(JSON.stringify(update)!==JSON.stringify(this.cardPayload(this.store.market(id))))this.store.setMetadata(key,randomUUID());
      else this.db.prepare("DELETE FROM prediction_meta WHERE key=? AND value=?").run(key,token);
      return msg;
    }catch{this.logger.warn?.(`[predictions] card update failed for market ${id}`);}
  }
  handleInteraction(i) {return require("./interactions").handleInteraction(this,i);}
  handleAdminCommand(message,args) {return require("./admin").handleAdminCommand(this,message,args);}
  handleBankCommand(message,command) {return require("./bank").handleBankCommand(this,message,command);}
  stop() {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
module.exports={PredictionsService,termsKey};
