"use strict";
// Recheck after Discord awaits, then make match writes and financial transitions
// one synchronous unit. No network or in-memory mutation belongs in write().
function commitMatchTerms({db,predictions,row,next,write,context}) {
  const apply=()=>{
    const current=db.prepare("SELECT * FROM matches WHERE match_id=?").get(String(row.match_id));
    for(const field of ["blue_ids","red_ids","offense_ids","map_name","server_name","status"]){
      if(!current||current[field]!==row[field])throw new Error("Match changed while command was pending; retry");
    }
    if(predictions)return predictions.applyRosterChange({matchId:row.match_id,nextSnapshot:predictions.snapshotFromRow(next),applyMatchWrites:write,context});
    write();return null;
  };
  return db.inTransaction?apply():db.transaction(apply).immediate();
}
async function postMatchCard(predictions,market,channel,payload) {
  if(!market)return channel.send(payload);
  predictions.queueCardPublication(market.id,channel.id,payload);
  const message=await predictions.publishCard(market.id,channel);
  if(message?.id){
    // The normal match flow must arm its recorder/voice state without waiting
    // for an RCON timeout. Presence confirmation continues independently.
    predictions.reconcileServer(market.snapshot.serverKey).catch(()=>predictions.logger.warn?.("[predictions] background roster query failed"));
  }
  return message;
}
module.exports={commitMatchTerms,postMatchCard};
