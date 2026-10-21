"use strict";
const {randomUUID}=require("node:crypto");
const {PredictionStore,validSnapshot}=require("./store");
const {PresenceTracker,rosterPresence,parseStatus}=require("./presence");
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
    this.presence=new PresenceTracker();this.knownServers=new Set();this.inflight=new Map();this.cardJobs=new Set();this.timer=null;
    this.queryServerRoster=queryServerRoster|| (async serverKey=>parseStatus(await require("../services/rconClient").runRawRconCommand(serverKey,"status")));
    this.queryServerPhase=queryServerPhase||require("./phase").queryServerPhase;
    this.waitForRosterRetry=waitForRosterRetry||(()=>new Promise(resolve=>setTimeout(resolve,2000)));
    this.rosterSchedules=new Map();
  }
  context(prefix="system",actorId="system",reason) {return {operationKey:`${prefix}:${randomUUID()}`,actorId,reason,now:this.clock()};}
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
    const active=this.store.markets().find(m=>m.snapshot.serverKey===snapshot.serverKey&&m.match_id!==String(snapshot.matchId)&&!["void","settled"].includes(m.state));
    if(active)throw new Error("Assigned server already has an unresolved prediction market");
    const market=this.store.createMarket(snapshot,context);
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
      const next=this.store.createMarket(nextSnapshot,context);
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
  maybeStart(serverKey,authoritative=false) {
    if(!this.knownServers.has(serverKey))return;
    for(const m of this.store.markets().filter(m=>m.state==="open"&&m.snapshot.serverKey===serverKey)){
      if(rosterPresence([...m.snapshot.blueIds,...m.snapshot.redIds],m.snapshot.steamIdsByDiscordId,this.presence.get(serverKey)).allPresent){
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
            if(roster.mapName===m.snapshot.mapName)this.db.prepare("UPDATE prediction_markets SET phase_evidence=? WHERE id=?").run(JSON.stringify({...evidence,mapObserved:true}),m.id);
            else if(evidence.mapObserved||m.phase==="live"){this.store.markReview(m.id,"unexpected server map");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);this.refreshCard(m.id);}
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
        for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===serverKey&&["open","countdown"].includes(m.state))){this.store.markReview(m.id,"server monitoring unavailable");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);this.refreshCard(m.id);}
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
    this.presence.event(evt);
    for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===evt.serverKey&&!["settled","void"].includes(m.state))){
      const previousEvidence=JSON.parse(m.phase_evidence||"{}");
      if(evt.type==="map"&&evt.name!==m.snapshot.mapName&&(previousEvidence.mapObserved||m.phase==="live"))this.store.markReview(m.id,"unexpected server map");
      if(evt.type==="map"&&evt.name===m.snapshot.mapName&&m.phase!=="live"){
        const evidence=JSON.parse(m.phase_evidence||"{}");
        this.db.prepare("UPDATE prediction_markets SET phase_evidence=? WHERE id=?").run(JSON.stringify({...evidence,mapObserved:true,...(!evidence.anchorLogInstance&&evt.logInstance?{anchorLogInstance:evt.logInstance,anchorObservedAt:this.clock()}:{})}),m.id);
      }
      if(evt.type==="prediction_live_start"&&this.presence.state(evt.serverKey).mapName===m.snapshot.mapName){
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
    if(!m.settlement_version&&(m.closes_at==null||context.now<m.closes_at))this.store.markReview(m.id,"official result received before betting deadline");
    if((m.observed_result&&m.observed_result!==outcome)||(m.result&&m.result!==outcome))this.store.markReview(m.id,"official result changed; owner correction required");
    this.db.prepare("UPDATE prediction_markets SET observed_result=? WHERE id=?").run(outcome,m.id);
  }
  onMatchReported({matchId}) {
    const m=this.store.latest(matchId);if(!m||m.state==="void"||m.state==="review_required")return;
    const row=this.db.prepare("SELECT winner,status FROM matches WHERE match_id=?").get(String(matchId));
    if(!row||String(row.status).toLowerCase()!=="completed")return;
    const outcome=String(row.winner).toLowerCase();
    this.observeOfficialResult({matchId,outcome});
    if(this.store.market(m.id).state==="review_required")return;
    this.tick();
    if(!["closed","settled"].includes(this.store.market(m.id).state)){this.store.markReview(m.id,"result before betting deadline");return;}
    const result=this.store.settleMarket({marketId:m.id,outcome,context:this.context("settle")});this.refreshCard(m.id);return result;
  }
  async initialize() {
    this.tick();
    for(const m of this.store.markets())if(["open","countdown"].includes(m.state)){this.store.markReview(m.id,"restart: connection/terms history requires owner review");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);}
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get())for(const m of this.store.markets())if(m.state==="closed")this.onMatchReported({matchId:m.match_id});
    this.store.assertAccounting();
    await this.retryPendingCards();
    if(!this.timer){let cycle=0;this.timer=setInterval(()=>{this.tick();this.pollRosters();if(++cycle%15===0)this.retryPendingCards();},1000);this.timer.unref?.();}
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
  queueCardPublication(id,channelId) {if(channelId)this.db.prepare("UPDATE prediction_markets SET channel_id=? WHERE id=?").run(String(channelId),id);}
  async retryPendingCards() {
    if(!this.client)return;
    for(const row of this.db.prepare("SELECT key FROM prediction_meta WHERE key GLOB 'card_refresh:*'").all())await this.refreshCard(Number(row.key.slice("card_refresh:".length)));
    for(const m of this.store.markets().filter(m=>m.channel_id&&!m.message_id&&m.state!=="void"&&this.store.latest(m.match_id)?.id===m.id)){
      if(this.cardJobs.has(m.id))continue;this.cardJobs.add(m.id);
      try{
        const channel=await this.client.channels.fetch(m.channel_id);
        const update=require("./messages").cardUpdate(this.store.market(m.id),this.clock());
        const teams=`Match ${m.match_id}\nBlue / Team 1: ${m.snapshot.blueIds.map(id=>`<@${id}>`).join(", ")}\nRed / Team 2: ${m.snapshot.redIds.map(id=>`<@${id}>`).join(", ")}\n`;
        const message=await channel.send({...update,content:teams+update.content,allowedMentions:{parse:[]}});this.bindMessage(m.id,message);
      }catch{this.logger.warn?.(`[predictions] pending card still unavailable for ${m.id}`);}finally{this.cardJobs.delete(m.id);}
    }
  }
  async refreshCard(id) {
    const key=`card_refresh:${id}`,m=this.store.market(id);
    if(!m?.channel_id){this.db.prepare("DELETE FROM prediction_meta WHERE key=?").run(key);return;}
    // Pending publication may bind a message later; retain its refresh request.
    if(!m.message_id)return;
    const token=randomUUID();this.store.setMetadata(key,token);
    if(!this.client)return;
    try{
      const channel=await this.client.channels.fetch(m.channel_id),msg=await channel.messages.fetch(m.message_id);
      const update=require("./messages").cardUpdate(this.store.market(id),this.clock());
      await msg.edit(update);
      if(JSON.stringify(update)!==JSON.stringify(require("./messages").cardUpdate(this.store.market(id),this.clock())))this.store.setMetadata(key,randomUUID());
      else this.db.prepare("DELETE FROM prediction_meta WHERE key=? AND value=?").run(key,token);
    }catch{this.logger.warn?.(`[predictions] card update failed for market ${id}`);}
  }
  handleInteraction(i) {return require("./interactions").handleInteraction(this,i);}
  handleAdminCommand(message,args) {return require("./admin").handleAdminCommand(this,message,args);}
  stop() {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
module.exports={PredictionsService,termsKey};
