"use strict";
const { PermissionFlagsBits: P, EmbedBuilder,escapeMarkdown } = require("discord.js");
const crypto = require("crypto");
function formatGapFinding(data){
  const small=data.conc_eligible<25||data.outside_eligible<25;
  return {name:escapeMarkdown(`${data.player_name||data.steam_id} · ${data.weapon}`.slice(0,200)),
    value:`${escapeMarkdown(data.steam_id)} · class ${data.class_id}\nConc: **${data.conc_percent.toFixed(1)}%** (${data.conc_near}/${data.conc_eligible} eligible)\nNon-conc: **${data.outside_percent.toFixed(1)}%** (${data.outside_near}/${data.outside_eligible} eligible)\nGap: **${data.gap_points.toFixed(2)} percentage points**`+
      (small?"\n⚠ Below 25 eligible shots in at least one state.":""),inline:false};
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
      const row = db.transaction(() => {
        const job = db.prepare("SELECT * FROM hltv_alerts WHERE sent_at IS NULL AND attempts<12 AND next_attempt<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at LIMIT 1").get(Date.now(), Date.now());
        if (!job) return null;
        const lease = crypto.randomUUID();
        db.prepare("UPDATE hltv_alerts SET lease=?,lease_until=? WHERE id=?").run(lease, Date.now() + 120000, job.id);
        return { ...job, lease };
      }).immediate();
      if (!row) return;
      try {
        const url = new URL("/admin/hltv-review", env.HLTV_REVIEW_BASE_URL);
        if (url.protocol !== "https:") throw new Error("HTTPS review URL required");
        if (row.demo_id) url.searchParams.set("demo", row.demo_id);
        const titles = {
          manual_flag: "HLTV Review — Manual Flag",
          player_report: "HLTV Review — Player Report",
          analyzer_finding: "HLTV Review — Analyzer Finding",
          aim_gap_review: "HLTV Review — Close Conc / Non-conc Aim Rates",
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
        if(row.kind==="aim_gap_review"){
          const demo=db.prepare("SELECT match_id,map FROM hltv_demos WHERE id=?").get(row.demo_id);
          const findings=db.prepare("SELECT data_json FROM hltv_gap_findings WHERE alert_id=? ORDER BY id").all(row.id).map(f=>JSON.parse(f.data_json));
          if(!findings.length)throw new Error("Missing aim-gap finding data");
          embed.setDescription("Configured review trigger: aim-near rates differ by less than 10 percentage points. These are estimates for human review, not a cheating verdict.");
          if(demo)embed.addFields({name:"Match / map",value:escapeMarkdown(`${demo.match_id} / ${demo.map}`).slice(0,1000)});
          for(const finding of findings.slice(0,10))embed.addFields(formatGapFinding(finding));
          if(findings.length>10)embed.addFields({name:"Additional comparisons",value:`${findings.length-10} more are available on the review page.`});
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
module.exports = { privateChannel, startHltvReviewAlerts,formatGapFinding };
