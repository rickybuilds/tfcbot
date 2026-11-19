"use strict";
const { PermissionFlagsBits: P, EmbedBuilder,escapeMarkdown } = require("discord.js");
const crypto = require("crypto");
function formatGapFinding(data){
  const small=data.conc_eligible<25||data.outside_eligible<25;
  return {name:escapeMarkdown(`${data.player_name||data.steam_id} · ${data.weapon}`.slice(0,200)),
    value:`${escapeMarkdown(data.steam_id)} · class ${data.class_id}\nConc: **${data.conc_percent.toFixed(1)}%** (${data.conc_near}/${data.conc_eligible} eligible)\nNon-conc: **${data.outside_percent.toFixed(1)}%** (${data.outside_near}/${data.outside_eligible} eligible)\nGap: **${data.gap_points.toFixed(2)} percentage points**`+
      (small?"\n⚠ Below 25 eligible shots in at least one state.":""),inline:false};
}
function formatAimFinding(data){
  const reasons={high_conc:"High strict hit evidence during estimated conc windows",repeated_gap:"Repeated close hit-evidence rates across games",baseline_rise:"Strict hit evidence above the earlier-game baseline"};
  let value=`${escapeMarkdown(data.steam_id)} · class ${data.class_id}\n${reasons[data.trigger]||"Configured hit-evidence review trigger"}\nConc: **${data.conc_percent.toFixed(1)}%** (${data.conc_hits}/${data.conc_eligible} eligible)\n`;
  value+=data.outside_percent==null?"Non-conc: unavailable\n":`Non-conc: **${data.outside_percent.toFixed(1)}%** (${data.outside_hits}/${data.outside_eligible} eligible)\n`;
  value+=`Coverage: **${data.conc_windows} distinct concussion windows** with eligible hit-evidence firing.\n`;
  if(data.trigger==="repeated_gap")value+=`Close rates in ${data.repetition.qualifying_games} of ${data.repetition.window_games} recent comparable games.\n`;
  if(data.baseline?.ready)value+=`Earlier strict-hit baseline: **${data.baseline.percent.toFixed(1)}%** (${data.baseline.hits}/${data.baseline.eligible} eligible, ${data.baseline.games} games).`;
  else value+=`Baseline building: ${data.baseline?.games||0}/${data.baseline?.required_games||25} earlier comparable games. Immediate triggers do not wait for this baseline.`;
  return {name:escapeMarkdown(`${data.player_name||data.steam_id} · ${data.weapon}`.slice(0,200)).slice(0,256),value:value.slice(0,1024),inline:false};
}
function addAimFindingFields(embed,findings){
  const json=embed.toJSON();let used=(json.title?.length||0)+(json.description?.length||0)+(json.footer?.text?.length||0)+(json.fields||[]).reduce((sum,field)=>sum+field.name.length+field.value.length,0)+500,shown=0;
  for(const finding of findings.slice(0,10)){const field=formatAimFinding(finding);if(used+field.name.length+field.value.length>5800)break;embed.addFields(field);used+=field.name.length+field.value.length;shown++;}
  return shown;
}
function hltvTime(seconds){const total=Math.max(0,Number(seconds)||0),minutes=Math.floor(total/60),whole=Math.floor(total%60),millis=Math.round((total-Math.floor(total))*1000);return `${String(minutes).padStart(2,"0")}:${String(whole).padStart(2,"0")}.${String(millis).padStart(3,"0")}`;}
function compactPercent(value){return Number.isFinite(Number(value))?`${Number(value).toFixed(1)}%`:"—";}
function formatHltvAnalysisNotification(data,reviewUrl){
  if(!data||!['completed_empty','candidates_found','failed'].includes(data.outcome))throw new Error("Invalid HLTV analysis notification");
  const url=new URL(reviewUrl);if(url.protocol!=="https:")throw new Error("HTTPS review URL required");if(!/^\d{17,20}$/.test(String(data.demo_id||""))&&typeof data.demo_id!=="string")throw new Error("Invalid HLTV demo identity");
  url.searchParams.set("demo",String(data.demo_id));if(data.outcome==="candidates_found"&&data.candidates?.[0]?.kind)url.searchParams.set("tab",data.candidates[0].kind==="snap"?"Snaps":"Wall-Track");
  const failed=data.outcome==="failed",candidate=data.outcome==="candidates_found",embed=new EmbedBuilder().setColor(failed?0xed4245:candidate?0xfaa61a:0x57f287).setTitle(`NN//TFC · HLTV ANALYSIS ${failed?"FAILED":"COMPLETE"}`).setTimestamp().setFooter({text:`Run ${String(data.run_id||"unknown").slice(0,80)}`});
  embed.addFields({name:"Match / map",value:`${escapeMarkdown(String(data.match_id||"Unknown match"))} / ${escapeMarkdown(String(data.map||"Unknown map"))}`,inline:true},{name:"Status",value:failed?"Analysis Failed":candidate?"Candidates Found":"No candidates",inline:true});
  if(failed){embed.addFields({name:"Failure",value:`${String(data.failure_code||"upstream_failed").slice(0,80)} · ${escapeMarkdown(String(data.failure_message||"Analysis failed")).slice(0,700)}`,inline:false},{name:"Next action",value:`${escapeMarkdown(String(data.next_action||"Inspect the Investigation Console and retry when ready.")).slice(0,700)}${data.retryable?"": "\nRetry is not currently indicated."}`,inline:false});}
  else {embed.addFields({name:"Wall-track",value:String(Number(data.wall_track_count)||0),inline:true},{name:"Snaps",value:String(Number(data.snap_count)||0),inline:true},{name:"Conc %",value:compactPercent(data.conc_percent),inline:true},{name:"Non-conc %",value:compactPercent(data.outside_percent),inline:true},{name:"Gap",value:Number.isFinite(Number(data.gap_points))?`${Number(data.gap_points).toFixed(1)} pts${Number.isFinite(Number(data.gap_threshold))?` / <${Number(data.gap_threshold).toFixed(1)}`:""}`:"—",inline:true});if(candidate){const rows=Array.isArray(data.candidates)?data.candidates:[],shown=[];for(const item of rows.slice(0,7)){const label=item.kind==="snap"?"Snap":"Wall-track",name=escapeMarkdown(String(item.player_name||"Identity unavailable")).slice(0,80),duration=Number.isFinite(item.duration_seconds)?` · Duration ${Number(item.duration_seconds).toFixed(2)}s`:"";shown.push(`${name} — ${label}\n\`${hltvTime(item.time_seconds)}\`${duration}`);}let value=shown.join("\n\n")||"No candidate details were recorded.",total=Math.max(rows.length,Number(data.candidate_count)||0);if(total>shown.length)value+=`\n\n… and ${total-shown.length} additional candidate event(s) available in the console.`;embed.addFields({name:"Candidate Events",value,inline:false});}}
  embed.addFields({name:"Review",value:`[Open Investigation Console](${url.href})\nHuman review required; not a cheating verdict.`,inline:false});
  return {embeds:[embed],allowedMentions:{parse:[]}};
}
function suppressLegacyGapAlert(db,row){
  if(row.kind!=="aim_gap_review")return false;
  db.prepare("INSERT OR IGNORE INTO hltv_alert_suppressions(alert_id,reason,created_at) VALUES(?,'Single-round gap rule retired; quiet website marker only',?)").run(row.id,Date.now());
  db.prepare("UPDATE hltv_alerts SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?").run(row.id,row.lease);
  return true;
}
function privateChannel(channel, allowed, botId) {
  if (!channel?.guildId || !allowed.size) return false;
  const entries = [...channel.permissionOverwrites.cache.values()];
  if (!entries.some(x => x.id === channel.guildId && x.deny.has(P.ViewChannel))) return false;
  return entries.every(x => !x.allow.has(P.ViewChannel) ||
    (x.type === 1 && (allowed.has(x.id) || x.id === botId)));
}
function startHltvReviewAlerts(client, env = process.env) {
  if (env.HLTV_REGISTRY_ENABLED !== "true" || env.HLTV_ALERTS_ENABLED !== "true") return;
  const allowed = new Set((env.HLTV_REVIEW_ALLOWED_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
  if (!env.HLTV_REGISTRY_DB || !/^\d{17,20}$/.test(env.HLTV_REVIEW_ALERT_CHANNEL_ID || "") || !allowed.size) {
    console.error("[HLTV alerts] missing dedicated channel, registry DB or user allowlist"); return;
  }
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    let db;
    try {
      const reviewChannel = await client.channels.fetch(env.HLTV_REVIEW_ALERT_CHANNEL_ID, { force: true });
      if (!privateChannel(reviewChannel, allowed, client.user.id) || !reviewChannel.isTextBased() || reviewChannel.isThread()) throw new Error("Alert channel privacy check failed");
      db = require("better-sqlite3")(env.HLTV_REGISTRY_DB, { fileMustExist: true, timeout: 5000 });
      db.exec("CREATE TABLE IF NOT EXISTS hltv_alert_suppressions(alert_id TEXT PRIMARY KEY REFERENCES hltv_alerts(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE IF NOT EXISTS hltv_analysis_notifications(alert_id TEXT PRIMARY KEY REFERENCES hltv_alerts(id),run_id TEXT NOT NULL UNIQUE REFERENCES hltv_upstream_runs(id),outcome TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL)");
      const row = db.transaction(() => {
        const job = db.prepare("SELECT * FROM hltv_alerts WHERE sent_at IS NULL AND id NOT IN(SELECT alert_id FROM hltv_alert_suppressions) AND attempts<12 AND next_attempt<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at LIMIT 1").get(Date.now(), Date.now());
        if (!job) return null;
        const lease = crypto.randomUUID();
        db.prepare("UPDATE hltv_alerts SET lease=?,lease_until=? WHERE id=?").run(lease, Date.now() + 120000, job.id);
        return { ...job, lease };
      }).immediate();
      if (!row) return;
      if(suppressLegacyGapAlert(db,row))return;
      const normalChannelId=String(env.HLTV_ANALYSIS_CHANNEL_ID||"").trim(),channel=row.kind==="hltv_analysis_complete"&&normalChannelId?await client.channels.fetch(normalChannelId,{force:true}):reviewChannel;
      if(channel!==reviewChannel&&(!channel?.isTextBased?.()||channel.isThread?.()))throw new Error("Analysis channel is not text-based");
      try {
        const url = new URL("/admin/hltv-review", env.HLTV_REVIEW_BASE_URL);
        if (url.protocol !== "https:") throw new Error("HTTPS review URL required");
        if (row.demo_id) url.searchParams.set("demo", row.demo_id);
        const titles = {
          manual_flag: "HLTV Review — Manual Flag",
          player_report: "HLTV Review — Player Report",
          analyzer_finding: "HLTV Review — Analyzer Finding",
          aim_gap_review: "HLTV Review — Close Conc / Non-conc Aim Rates",
          hit_evidence_review:"HLTV Review — Sampled Hit Evidence",
          storage_low_disk: "HLTV Storage — Low Disk Space"
        };
        if(row.kind.startsWith("hltv_analysis_")){
          const payloadRow=db.prepare("SELECT data_json FROM hltv_analysis_notifications WHERE alert_id=?").get(row.id);
          if(!payloadRow)throw new Error("Missing HLTV analysis notification payload");
          const payload=JSON.parse(payloadRow.data_json),reviewUrl=new URL("/admin/hltv-review",env.HLTV_REVIEW_BASE_URL);
          await channel.send(formatHltvAnalysisNotification(payload,reviewUrl.href));
        } else {
        if (!Object.hasOwn(titles, row.kind)) throw new Error("Unknown alert kind");
        // No free-form notes, allegations or automatic mentions in Discord.
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(titles[row.kind])
          .setFooter({ text: `Alert ID: ${row.id}` })
          .setTimestamp();
        if (row.demo_id) embed.addFields({ name: "Demo", value: String(row.demo_id), inline: false });
        if(row.kind==="hit_evidence_review"){
          const demo=db.prepare("SELECT match_id,map FROM hltv_demos WHERE id=?").get(row.demo_id);
          const findings=db.prepare("SELECT data_json FROM hltv_gap_findings WHERE alert_id=? ORDER BY id").all(row.id).map(f=>JSON.parse(f.data_json));
          if(!findings.length)throw new Error("Missing aim-pattern finding data");
          embed.setDescription("Strict hit-evidence review: high conc performance, repetition across games or an earlier-game baseline increase. Evidence associations are estimates, not exact bullet/pellet accuracy or a cheating verdict.");
          if(demo)embed.addFields({name:"Match / map",value:escapeMarkdown(`${demo.match_id} / ${demo.map}`).slice(0,1000)});
          const shown=addAimFindingFields(embed,findings);
          if(findings.length>shown)embed.addFields({name:"Additional comparisons",value:`${findings.length-shown} more are available on the review page.`});
        }
        embed.addFields({ name: "Links", value: `[View HLTV Review](${url.href})`, inline: false });
        await channel.send({ embeds: [embed],
          allowedMentions: { parse: [] } });
        }
        db.prepare("UPDATE hltv_alerts SET sent_at=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?").run(Date.now(), row.id, row.lease);
      } catch (error) {
        db.prepare("UPDATE hltv_alerts SET attempts=attempts+1,next_attempt=?,lease=NULL,lease_until=NULL WHERE id=? AND lease=?").run(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7)), row.id, row.lease);
        throw error;
      }
    } catch (error) { console.error("[HLTV alerts] delivery deferred:", error.message); }
    finally { db?.close(); running = false; }
  }
  const timer = setInterval(() => void drain(), 30000); timer.unref();
  return () => clearInterval(timer);
}
module.exports = { privateChannel, startHltvReviewAlerts,formatGapFinding,formatAimFinding,suppressLegacyGapAlert,addAimFindingFields,formatHltvAnalysisNotification };
