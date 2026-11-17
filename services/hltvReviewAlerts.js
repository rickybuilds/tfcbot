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
      const channel = await client.channels.fetch(env.HLTV_REVIEW_ALERT_CHANNEL_ID, { force: true });
      if (!privateChannel(channel, allowed, client.user.id) || !channel.isTextBased() || channel.isThread()) throw new Error("Alert channel privacy check failed");
      db = require("better-sqlite3")(env.HLTV_REGISTRY_DB, { fileMustExist: true, timeout: 5000 });
      db.exec("CREATE TABLE IF NOT EXISTS hltv_alert_suppressions(alert_id TEXT PRIMARY KEY REFERENCES hltv_alerts(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL)");
      const row = db.transaction(() => {
        const job = db.prepare("SELECT * FROM hltv_alerts WHERE sent_at IS NULL AND id NOT IN(SELECT alert_id FROM hltv_alert_suppressions) AND attempts<12 AND next_attempt<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at LIMIT 1").get(Date.now(), Date.now());
        if (!job) return null;
        const lease = crypto.randomUUID();
        db.prepare("UPDATE hltv_alerts SET lease=?,lease_until=? WHERE id=?").run(lease, Date.now() + 120000, job.id);
        return { ...job, lease };
      }).immediate();
      if (!row) return;
      if(suppressLegacyGapAlert(db,row))return;
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
module.exports = { privateChannel, startHltvReviewAlerts,formatGapFinding,formatAimFinding,suppressLegacyGapAlert,addAimFindingFields };
