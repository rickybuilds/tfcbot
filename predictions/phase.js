"use strict";
const path=require("node:path");
function phaseFromLog(raw,expectedMap) {
  const text=String(raw||"");
  if(!text.endsWith("\n"))return "unknown";
  const maps=[...text.matchAll(/^L [^\r\n]+: Started map "([^"]+)"[^\r\n]*$/gm)];
  if(!maps.length||maps.some(m=>m[1]!==expectedMap))return "unknown";
  const current=text.slice(maps[0].index);
  return /^L [^\r\n]+: World triggered "Match_Begins_Now"\s*$/m.test(current)?"live":"pregame";
}
// Read-only durable evidence complements the lossy UDP feed. A complete current
// log must come from a configured directory unique to the assigned endpoint.
async function queryServerPhase(serverKey,mapName,{anchorLogInstance,openedAt}={}) {
  const configs=require("../config/rcon"),cfg=configs[serverKey],ssh=cfg?.ssh;
  const envKey=serverKey.toUpperCase();
  const directory=process.env[`HL_REMOTE_LOG_DIR_${envKey}`]||process.env.HL_REMOTE_LOG_DIR;
  if(!directory||!ssh?.host||!ssh.user||!ssh.pass||!anchorLogInstance||!Number.isSafeInteger(openedAt))return {phase:"unknown"};
  const sameDirectory=Object.entries(configs).filter(([key,s])=>!s.trackingOnly&&s.ssh?.host===ssh.host&&(process.env[`HL_REMOTE_LOG_DIR_${key.toUpperCase()}`]||process.env.HL_REMOTE_LOG_DIR)===directory);
  if(sameDirectory.length!==1)return {phase:"unknown"};
  const Sftp=require("ssh2-sftp-client"),sftp=new Sftp();
  try{
    await sftp.connect({host:ssh.host,port:ssh.port||22,username:ssh.user,password:ssh.pass,readyTimeout:5000});
    const files=(await sftp.list(directory)).filter(f=>/^L\d+\.log$/i.test(f.name)&&f.type!=="d").sort((a,b)=>b.modifyTime-a.modifyTime||b.name.localeCompare(a.name));
    const anchorName=path.posix.basename(String(anchorLogInstance).replace(/\\/g,"/"));
    const index=files.findIndex(f=>f.name===anchorName),latest=files[0];
    if(index<0||index>15||!latest||latest.modifyTime<Math.max(openedAt-5000,Date.now()-30000))return {phase:"unknown"};
    const parts=[];
    for(const file of files.slice(0,index+1).reverse()){
      if(file.size>8*1024*1024)return {phase:"unknown"};
      const raw=await sftp.get(path.posix.join(directory,file.name));
      if(!Buffer.isBuffer(raw)||raw.length<file.size)return {phase:"unknown"};
      const text=raw.toString("utf8");
      if(!text.endsWith("\n")||!text.includes("Log file started")||!text.includes("Started map"))return {phase:"unknown"};
      parts.push(text);
    }
    return {phase:phaseFromLog(parts.join("\n"),mapName),logInstance:latest.name,anchorLogInstance:anchorName};
  }finally{await sftp.end().catch(()=>{});}
}
module.exports={phaseFromLog,queryServerPhase};
