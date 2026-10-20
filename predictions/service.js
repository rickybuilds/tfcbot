"use strict";
const {randomUUID}=require("node:crypto");
const {PredictionStore,validSnapshot}=require("./store");
const {PresenceTracker,rosterPresence,parseStatus}=require("./presence");
function termsKey(s) {
  return JSON.stringify([s.blueIds.slice().sort(),s.redIds.slice().sort(),(s.offenseIds||[]).slice().sort(),s.serverKey,s.mapName,s.team1Starts]);
}
class PredictionsService {
  constructor({db,client,config={},clock=Date.now,logger=console,queryServerRoster}) {
    this.store=new PredictionStore(db);this.db=db;this.client=client;this.config=config;this.clock=clock;this.logger=logger;
    this.presence=new PresenceTracker();this.knownServers=new Set();this.inflight=new Map();this.timer=null;
    this.queryServerRoster=queryServerRoster|| (async serverKey=>parseStatus(await require("../services/rconClient").runRawRconCommand(serverKey,"status")));
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
    const active=this.store.markets().find(m=>m.snapshot.serverKey===snapshot.serverKey&&m.match_id!==String(snapshot.matchId)&&!["void","settled"].includes(m.state));
    if(active)throw new Error("Assigned server already has an unresolved prediction market");
    return this.store.createMarket(snapshot,context);
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
      return this.store.createMarket(nextSnapshot,context);
    });
  }
  maybeStart(serverKey) {
    if(!this.knownServers.has(serverKey))return;
    for(const m of this.store.markets().filter(m=>m.state==="open"&&m.snapshot.serverKey===serverKey)){
      if(this.presence.state(serverKey).mapName!==m.snapshot.mapName)continue;
      if(rosterPresence([...m.snapshot.blueIds,...m.snapshot.redIds],m.snapshot.steamIdsByDiscordId,this.presence.get(serverKey)).allPresent){this.store.startCountdown(m.id,this.clock());this.refreshCard(m.id);}
    }
  }
  async reconcileServer(serverKey) {
    if(this.inflight.has(serverKey))return this.inflight.get(serverKey);
    const token=this.presence.beginQuery(serverKey);
    const work=(async()=>{
      try{
        const roster=await this.queryServerRoster(serverKey);
        if(!roster.complete)throw new Error("Incomplete roster");
        if(this.presence.reconcile(serverKey,token,roster)){this.knownServers.add(serverKey);this.maybeStart(serverKey);}
      }catch(error){
        this.knownServers.delete(serverKey);
        for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===serverKey&&["open","countdown"].includes(m.state))){this.store.markReview(m.id,"server monitoring unavailable");this.db.prepare("UPDATE prediction_markets SET phase='unknown' WHERE id=?").run(m.id);this.refreshCard(m.id);}
        this.logger.warn?.(`[predictions] roster reconciliation failed for ${serverKey}`);
      }
    })();
    this.inflight.set(serverKey,work);try{return await work;}finally{this.inflight.delete(serverKey);}
  }
  onHldsEvent(evt) {
    if(!evt.serverKey)return;
    this.presence.event(evt);
    for(const m of this.store.markets().filter(m=>m.snapshot.serverKey===evt.serverKey&&!["settled","void"].includes(m.state))){
      if(evt.type==="map"&&evt.name!==m.snapshot.mapName)this.store.markReview(m.id,"unexpected server map");
      if(evt.type==="prediction_live_start"&&(!this.presence.state(evt.serverKey).mapName||this.presence.state(evt.serverKey).mapName===m.snapshot.mapName)){
        this.db.prepare("UPDATE prediction_markets SET phase='live',live_at=COALESCE(live_at,?),phase_evidence=? WHERE id=?").run(evt.receivedAt||evt.ts||this.clock(),JSON.stringify({sourceTime:evt.sourceTime,logInstance:evt.logInstance,sourceKey:evt.sourceKey}),m.id);
      }
    }
    this.maybeStart(evt.serverKey);
  }
  tick() {
    for(const m of this.store.markets())if(["open","countdown"].includes(m.state)&&m.closes_at!=null&&this.clock()>=m.closes_at){this.store.closeMarket(m.id,this.context("deadline"));this.refreshCard(m.id);}
  }
  observeOfficialResult({matchId,outcome,context=this.context("result")}) {
    const m=this.store.latest(matchId);if(!m||m.state==="void")return;
    outcome=String(outcome).toLowerCase();if(!["blue","red","tie"].includes(outcome))throw new Error("Invalid official outcome");
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
    if(!this.timer){let cycle=0;this.timer=setInterval(()=>{this.tick();if(++cycle%15===0){const keys=new Set(this.store.markets().filter(m=>["open","countdown"].includes(m.state)).map(m=>m.snapshot.serverKey));for(const key of keys)this.reconcileServer(key);}},1000);this.timer.unref?.();}
  }
  assertCanDeleteMatch(matchId) {
    const all=this.store.markets().filter(m=>m.match_id===String(matchId));
    if(all.some(m=>m.settlement_version>0&&!m.deletion_authorized))throw new Error("Owner must authorize retaining settled prediction history before deletion");
  }
  applyMatchDeletion({matchId,applyMatchWrites,context=this.context("delete","system","match deleted")}) {
    return this.store.atomic(()=>{this.assertCanDeleteMatch(matchId);for(const m of this.store.markets().filter(m=>m.match_id===String(matchId)&&m.state!=="void"&&!m.settlement_version))this.store.voidMarket({marketId:m.id,context:{...context,operationKey:`${context.operationKey}:${m.id}`}});return applyMatchWrites();});
  }
  bindMessage(id,message) {this.db.prepare("UPDATE prediction_markets SET channel_id=?,message_id=? WHERE id=?").run(String(message.channelId||message.channel?.id),String(message.id),id);}
  async refreshCard(id) {
    const m=this.store.market(id);if(!this.client||!m?.channel_id||!m.message_id)return;
    try{const channel=await this.client.channels.fetch(m.channel_id);const msg=await channel.messages.fetch(m.message_id);await msg.edit(require("./messages").cardUpdate(m,this.clock()));}catch{this.logger.warn?.(`[predictions] card update failed for market ${id}`);}
  }
  handleInteraction(i) {return require("./interactions").handleInteraction(this,i);}
  handleAdminCommand(message,args) {return require("./admin").handleAdminCommand(this,message,args);}
  stop() {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
module.exports={PredictionsService,termsKey};
