"use strict";
require("dotenv").config({path:require("path").resolve(__dirname,"../.env"),quiet:true});
const fs=require("fs"),path=require("path"),Sftp=require("ssh2-sftp-client");
const {getSftpConfig}=require("../services/hltvFetch"),{finalizationConfig}=require("../services/hltvFinalization");
const {recoverSourceFile}=require("../services/hltvSourceRecovery");
async function main(){
  const args=process.argv.slice(2);let apiRoot="/var/www/tfcbot/api",match=null,apply=false,analyze=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==="--apply")apply=true;
    else if(args[i]==="--analyze")analyze=true;
    else if(args[i]==="--api-root"&&args[i+1])apiRoot=args[++i];
    else if(args[i]==="--match"&&/^[A-Za-z0-9_-]{1,100}$/.test(args[i+1]||""))match=args[++i];
    else throw Error("Usage: recoverHltvSources.js --apply [--analyze] [--match MATCH_ID] [--api-root /var/www/tfcbot/api]");
  }
  if(!apply)throw Error("Run checkHltvSources.js first. Recovery requires --apply and the shared worker flock.");
  if(!path.isAbsolute(apiRoot))throw Error("API root must be absolute");
  apiRoot=fs.realpathSync(apiRoot);
  const env={...process.env,...require("dotenv").parse(fs.readFileSync(path.join(apiRoot,".env")))},cfg=require(path.join(apiRoot,"src/hltv/config")).config(env);
  if(process.env.HLTV_REGISTRY_ENABLED!=="true"||!cfg.enabled)throw Error("Registry must be enabled in both bot and API");
  const upstream=require(path.join(apiRoot,"src/hltv/upstream")).upstreamConfig(env);
  if(!upstream.enabled||!upstream.statisticsEnabled)throw Error("Enable API upstream and statistics before queuing recovered recordings");
  if(path.resolve(cfg.root)!==path.resolve(process.env.HLTV_STORAGE_ROOT||"")||path.resolve(cfg.database)!==path.resolve(process.env.HLTV_REGISTRY_DB||""))throw Error("Bot and API must use the same storage and registry");
  const registry=new (require(path.join(apiRoot,"src/hltv/registry")).Registry)(cfg);
  let sftp,server,failed=0;const jobs=[],summary={recovered:0,existing:0,skipped:0,failed:0,analysis_failed:0};
  try{
    if(typeof registry.recoverFinalizedSource!=="function")throw Error("Update nonamepickup-web before recovering sources");
    const options=finalizationConfig(env);
    const rows=registry.db.prepare(`SELECT d.* FROM hltv_demos d JOIN hltv_upstream_runs r ON r.id=(SELECT id FROM hltv_upstream_runs WHERE demo_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1)
      WHERE d.file_status='available' AND r.status='failed' AND (? IS NULL OR d.match_id=?)
      AND NOT EXISTS(SELECT 1 FROM hltv_source_recoveries c WHERE c.recovered_demo_id=d.id)
      ORDER BY d.server,d.match_id,d.filename LIMIT 100`).all(match,match);
    for(const original of rows){
      try{
        if(path.basename(original.filename)!==original.filename||original.filename.includes("\\"))throw Error("Unsafe source filename");
        const existing=registry.db.prepare("SELECT recovered_demo_id,run_id FROM hltv_source_recoveries WHERE original_demo_id=?").get(original.id);
        let result;
        if(existing)result={demo_id:existing.recovered_demo_id,run_id:existing.run_id,existing:true};
        else{
          const cfg=getSftpConfig(original.server);if(!cfg.host||!cfg.username||!cfg.hltvDir)throw Error("Missing server SFTP configuration");
          if(!sftp||server!==original.server){if(sftp)await sftp.end();sftp=new Sftp();server=original.server;await sftp.connect({host:cfg.host,port:cfg.port,username:cfg.username,password:cfg.password,readyTimeout:20000});}
          result=await recoverSourceFile(registry,sftp,original,`${cfg.hltvDir}/${original.filename}`,options);
        }
        summary[result.existing?"existing":result.skipped?"skipped":"recovered"]++;
        if(result.run_id)jobs.push(result.run_id);
        console.log(JSON.stringify({match:original.match_id,original_demo_id:original.id,...result}));
      }catch(error){summary.failed++;failed++;console.log(JSON.stringify({match:original.match_id,original_demo_id:original.id,error:error.message}));if(sftp){try{await sftp.end();}catch{}sftp=null;server=null;}if(error.message==="insufficient_storage_headroom")break;}
    }
    if(sftp){await sftp.end();sftp=null;server=null;}
    if(analyze)for(const runId of jobs){const result=await require(path.join(apiRoot,"src/hltv/upstream")).runPending(registry,{...upstream,runId});console.log(JSON.stringify({analysis:result}));if(result.status==="failed"){summary.analysis_failed++;failed++;}if(result.error_code==="insufficient_storage_headroom")break;}
    console.log(JSON.stringify({summary,note:analyze?"Requested recovery runs processed or already terminal; inspect per-run output. Originals and review history are unchanged.":"Completed versions are queued. Originals and their review history remain unchanged."}));
    if(failed)process.exitCode=1;
  }finally{if(sftp)await sftp.end();registry.close();}
}
main().catch(error=>{console.error("[HLTV recovery]",error.message);process.exitCode=1;});
