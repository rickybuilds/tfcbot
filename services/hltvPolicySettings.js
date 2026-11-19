"use strict";
const Database=require("better-sqlite3");
const KEY="aim_review:evidence_gap_points",DEFAULT=7;
function withDb(callback){
  const filename=String(process.env.HLTV_REGISTRY_DB||"").trim();
  if(!filename)return null;
  const db=new Database(filename,{fileMustExist:true,timeout:5000});
  try { db.exec("CREATE TABLE IF NOT EXISTS hltv_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)"); return callback(db); }
  finally { db.close(); }
}
function getEvidenceGapPoints(){try{return withDb(db=>{const row=db.prepare("SELECT value FROM hltv_settings WHERE key=?").get(KEY),value=Number(row?.value);return Number.isFinite(value)?value:DEFAULT;})??DEFAULT;}catch{return DEFAULT;}}
function setEvidenceGapPoints(value){return withDb(db=>db.prepare("INSERT INTO hltv_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(KEY,String(value),Date.now()));}
module.exports={DEFAULT,KEY,getEvidenceGapPoints,setEvidenceGapPoints};
