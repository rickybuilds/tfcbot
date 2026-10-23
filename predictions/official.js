"use strict";
function sameMap(a,b) {
  const name=value=>String(value||'').trim().toLowerCase();
  return !!name(a)&&name(a)===name(b);
}
function roster(value) {
  try {
    const ids=Array.isArray(value)?value:JSON.parse(value);
    if(!Array.isArray(ids)||ids.length!==4||ids.some(id=>!["string","number"].includes(typeof id)||!String(id).trim()))return null;
    const normalized=ids.map(String).sort();
    return new Set(normalized).size===4?normalized:null;
  }catch{return null;}
}
function officialTermsMismatch(row,snapshot,{allowMapChange=false}={}) {
  const blue=roster(row?.blue_ids),red=roster(row?.red_ids),frozenBlue=roster(snapshot?.blueIds),frozenRed=roster(snapshot?.redIds);
  if(!blue||!red||!frozenBlue||!frozenRed||new Set([...blue,...red]).size!==8||new Set([...frozenBlue,...frozenRed]).size!==8||JSON.stringify(blue)!==JSON.stringify(frozenBlue)||JSON.stringify(red)!==JSON.stringify(frozenRed))return 'teams';
  if(!String(row?.map_name||'').trim()||!String(snapshot?.mapName||'').trim()||(!allowMapChange&&!sameMap(row.map_name,snapshot.mapName)))return 'map';
  if(!String(row?.server_name||'').trim()||!String(snapshot?.serverKey||'').trim())return 'server';
  const {determineServerKey}=require('../services/autoRecap');
  const actual=determineServerKey(row.server_name),assigned=determineServerKey(snapshot.serverKey);
  return actual&&assigned&&actual===assigned?null:'server';
}
function acceptedMapChange(db,market,row) {
  if(!market?.settlement_version||!row)return false;
  for(const audit of db.prepare("SELECT metadata FROM prediction_transactions WHERE market_id=? AND kind='owner_settlement'").iterate(market.id)){
    try {
      const change=JSON.parse(audit.metadata)?.mapChange;
      if(change?.accepted===true&&sameMap(change.predictionMap,market.snapshot.mapName)&&sameMap(change.officialMap,row.map_name))return true;
    }catch{/* Invalid history cannot authorize a terms exception. */}
  }
  return false;
}
module.exports={sameMap,officialTermsMismatch,acceptedMapChange};
