"use strict";
const path=require("node:path");
function phaseFromLog(raw,expectedMap) {
  const text=String(raw||"");
  if(!text.endsWith("\n"))return "unknown";
  const maps=[...text.matchAll(/^L [^\r\n]+: Started map "([^"]+)"[^\r\n]*$/gm)];
  const last=maps.at(-1);if(!last||last[1]!==expectedMap)return "unknown";
  const current=text.slice(last.index);
  return /^L [^\r\n]+: World triggered "Match_Begins_Now"\s*$/m.test(current)?"live":"pregame";
}
// Read-only durable evidence complements the lossy UDP feed. A complete current
// log must come from a configured directory unique to the assigned endpoint.
async function queryServerPhase(serverKey,mapName) {
  const configs=require("../config/rcon"),cfg=configs[serverKey],ssh=cfg?.ssh;
  const envKey=serverKey.toUpperCase();
  const directory=process.env[`HL_REMOTE_LOG_DIR_${envKey}`]||process.env.HL_REMOTE_LOG_DIR;
  if(!directory||!ssh?.host||!ssh.user||!ssh.pass)return {phase:"unknown"};
  const sameDirectory=Object.entries(configs).filter(([key,s])=>!s.trackingOnly&&s.ssh?.host===ssh.host&&(process.env[`HL_REMOTE_LOG_DIR_${key.toUpperCase()}`]||process.env.HL_REMOTE_LOG_DIR)===directory);
  if(sameDirectory.length!==1)return {phase:"unknown"};
  const Sftp=require("ssh2-sftp-client"),sftp=new Sftp();
  try{
    await sftp.connect({host:ssh.host,port:ssh.port||22,username:ssh.user,password:ssh.pass,readyTimeout:5000});
    const files=(await sftp.list(directory)).filter(f=>/^L\d+\.log$/i.test(f.name)&&f.type!=="d").sort((a,b)=>b.modifyTime-a.modifyTime||b.name.localeCompare(a.name));
    const latest=files[0];if(!latest||latest.size>8*1024*1024)return {phase:"unknown"};
    const raw=await sftp.get(path.posix.join(directory,latest.name));
    if(!Buffer.isBuffer(raw)||raw.length<latest.size)return {phase:"unknown"};
    return {phase:phaseFromLog(raw.toString("utf8"),mapName),logInstance:latest.name};
  }finally{await sftp.end().catch(()=>{});}
}
module.exports={phaseFromLog,queryServerPhase};
