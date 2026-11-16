"use strict";
const { PermissionFlagsBits: P } = require("discord.js");
const crypto = require("crypto");
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
        if (!["manual_flag", "player_report", "analyzer_finding", "storage_low_disk"].includes(row.kind)) throw new Error("Unknown alert kind");
        // No notes, allegations, player data or automatic mentions in Discord.
        await channel.send({ content: `HLTV private review: ${row.kind}\nDemo ${row.demo_id}\n${url.href}\nAlert ${row.id}`,
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
module.exports = { privateChannel, startHltvReviewAlerts };
