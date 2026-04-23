// lib/eloDecay.js
"use strict";

const { EmbedBuilder } = require("discord.js");

/* settings helpers */
function getNum(settings, key, fallback) {
  try {
    const raw = settings.get ? settings.get(key) : undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch { return fallback; }
}
function setNum(settings, key, value) {
  try { settings?.set?.(key, Number(value)); } catch {}
}

function getLastGameTs(elo, userId) {
  try {
    const row = elo.db.prepare(`
      SELECT MAX(ts) AS last_ts
      FROM rating_changes
      WHERE player_id = ?
    `).get(String(userId));
    const sec = Number(row?.last_ts || 0);
    return Number.isFinite(sec) ? sec : 0;
  } catch { return 0; }
}
function getAllRatings(elo) {
  try { return elo.db.prepare(`SELECT player_id AS id, rating FROM ratings`).all(); }
  catch { return []; }
}

function applyDecayTo(elo, userId, rating, percent, minDrop) {
  const above = Math.max(0, rating - 1200);
  const pctDrop = Math.floor(above * (percent / 100));
  const decay = Math.max(pctDrop, minDrop);
  const newRating = Math.max(300, Math.floor(rating - decay));

  if (newRating === rating) return null;

  try {
    const delta = newRating - rating;
    const res = elo.bump(userId, delta, "decay");
    return res;
  } catch (e) {
    console.error("[eloDecay] applyDecayTo failed:", e);
    return null;
  }
}

/**
 * Kicks off Elo decay schedule and reports decays to Audit Channel
 */
function scheduleDecayIfNeeded(client, { elo, settings }) {
  const DAY = 24 * 60 * 60 * 1000;

  const run = async () => {
    try {
      const rows = getAllRatings(elo);
      const nowMs = Date.now();
      const cutoffMs = nowMs - 30 * DAY;

      const percent = getNum(settings, "decay:percent", 5);
      const minDrop = getNum(settings, "decay:min", 10);
      const cooldownDays = getNum(settings, "decay:cooldown_days", 7);

      for (const r of rows) {
        const uid = String(r.id);
        const lastGameSec = getLastGameTs(elo, uid);
        const lastGameMs = lastGameSec * 1000;
        if (lastGameMs && lastGameMs > cutoffMs) continue;

        const lastDecayMs = getNum(settings, `decay:last:${uid}`, 0);
        if (nowMs - lastDecayMs < cooldownDays * DAY) continue;

        const rating = Math.round(Number(r.rating) || 0);
        const res = applyDecayTo(elo, uid, rating, percent, minDrop);
        if (res) {
          setNum(settings, `decay:last:${uid}`, nowMs);

          // 📢 Send audit log
          const auditId = process.env.AUDIT_CHANNEL_ID;
          if (auditId && client?.channels?.cache) {
            const channel = client.channels.cache.get(auditId);
            if (channel) {
              const embed = new EmbedBuilder()
                .setTitle("Elo Decay Applied")
                .setDescription(`Player **<@${uid}>** (${uid}) decayed due to inactivity.`)
                .addFields(
                  { name: "Before", value: String(res.before), inline: true },
                  { name: "After", value: String(res.after), inline: true },
                  { name: "Delta", value: String(res.delta), inline: true }
                )
                .setColor(res.delta < 0 ? 0xff0000 : 0x00ff00)
                .setTimestamp();

              channel.send({ embeds: [embed] }).catch(() => {});
            }
          }

          if (process.env.DEBUG_ELO_DECAY) {
            console.log(`[eloDecay] ${uid} decayed ${res.delta} → ${res.after}`);
          }
        }
      }
    } catch (e) {
      console.error("[eloDecay] run failed:", e);
    }
  };

  run();
  if (!global.__elo_decay_timer) {
    global.__elo_decay_timer = setInterval(run, DAY);
  }
}

module.exports = { scheduleDecayIfNeeded };
