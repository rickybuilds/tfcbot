"use strict";
const fs=require("fs"),path=require("path");
const {probeRemoteDemo,verifyDownloaded,sameStat,inspectHeader}=require("./hltvFinalization");
const safe=value=>String(value||"unknown").replace(/[^A-Za-z0-9_-]/g,"_").slice(0,60);
async function recoverSourceFile(registry,sftp,original,remotePath,options={}) {
  const linked=registry.db.prepare("SELECT recovered_demo_id,run_id FROM hltv_source_recoveries WHERE original_demo_id=?").get(original.id);
  if(linked)return {demo_id:linked.recovered_demo_id,run_id:linked.run_id,existing:true};
  const old=registry.storage.verify(original),header=Buffer.alloc(544),fd=fs.openSync(old.path,"r");
  let info;try{const n=fs.readSync(fd,header,0,544,0);info=inspectHeader(header.subarray(0,n),old.size,original.map);}finally{fs.closeSync(fd);}
  if(info.reason!=="unfinalized_demo")return {skipped:true,reason:"local_source_is_not_unfinished"};
  const snapshot=await probeRemoteDemo(sftp,remotePath,original.map,options);
  if(!snapshot.finalized)return {skipped:true,reason:snapshot.reason};
  const root=registry.storage.root,incoming=path.join(root,"incoming");
  fs.mkdirSync(incoming,{recursive:true,mode:0o700});if(fs.realpathSync(incoming)!==incoming)throw new Error("Unsafe incoming directory");
  const directory=path.join(incoming,`${safe(original.match_id)}-${safe(original.map)}-${safe(original.server)}-recovery-${original.id}`);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.realpathSync(directory)!==directory)throw new Error("Unsafe recovery directory");
  const name=`${safe(original.match_id)}-${safe(original.map)}-recovered.dem`,target=path.join(directory,name),partial=target+".part";
  let downloaded=false;
  if(!fs.existsSync(target)) {
    if(registry.storage.freeBytes()<registry.minFreeBytes+snapshot.size)throw new Error("insufficient_storage_headroom");
    const reserve=fs.openSync(partial,"wx",0o600);fs.closeSync(reserve);
    await sftp.fastGet(remotePath,partial);
    verifyDownloaded(partial,snapshot);
    if(!sameStat(snapshot,await sftp.stat(remotePath)))throw new Error("HLTV_SOURCE_CHANGED_DURING_RECOVERY");
    fs.renameSync(partial,target);downloaded=true;
  } else verifyDownloaded(target,snapshot);
  const result=registry.recoverFinalizedSource(original.id,{storage_key:path.relative(root,target).split(path.sep).join("/"),filename:name},"source-recovery");
  return {...result,downloaded};
}
module.exports={recoverSourceFile};
