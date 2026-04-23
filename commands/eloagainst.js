// commands/eloagainst.js
"use strict";

const { EmbedBuilder, AttachmentBuilder } = require("discord.js");

function formatTimestamp() {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: "America/New_York", // adjust if needed
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/* --------------------- helpers --------------------- */
const toArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0.0");

// Convert timestamp → MM/DD/YYYY
function isoFrom(ts) {
  const d = new Date((ts || 0) * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
    d.getDate()
  ).padStart(2, "0")}/${d.getFullYear()}`;
}

// --- Safe parse helper for blue_ids/red_ids ---
function safeParseIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  try {
    const inner = JSON.parse(JSON.parse(JSON.stringify(raw)));
    if (Array.isArray(inner)) return inner.map(String);
  } catch {}
  return [];
}

function mapNameOf(m) {
  if (!m) return "Unknown";
  if (m.map && typeof m.map === "object" && m.map.name) return m.map.name;
  return (
    m.mapName ??
    m.map_name ?? // ✅ support DB column
    m.map ??
    m?.vote?.map ??
    m?.voting?.map ??
    "Unknown"
  );
}

function findPlayerIdByName(elo, query) {
  try {
    const stmt = elo.db.prepare(`
      SELECT player_id, display_name
      FROM ratings
      WHERE LOWER(display_name) LIKE LOWER(?)
      LIMIT 5
    `);
    const rows = stmt.all(`%${query}%`);
    if (!rows.length) return { error: "⚠️ No player found matching that name." };
    if (rows.length > 1) {
      const names = rows.map((r) => `• ${r.display_name}`).join("\n");
      return { error: `⚠️ Multiple matches found:\n${names}` };
    }
    return { id: String(rows[0].player_id), name: rows[0].display_name };
  } catch (e) {
    console.error("[findPlayerIdByName] failed:", e);
    return { error: "⚠️ Failed to search player." };
  }
}

function userTeam(m, uid) {
  const target = String(uid);
  const blueIds = safeParseIds(m.blue_ids);
  const redIds = safeParseIds(m.red_ids);
  if (blueIds.includes(target)) return "Blue";
  if (redIds.includes(target)) return "Red";
  // fallback for memory matches
  const normalize = (p) => String(p?.id ?? p?.user_id ?? p?.userId ?? p ?? "");
  const blues = (m.blueTeam || m.blue || []).map(normalize);
  const reds = (m.redTeam || m.red || []).map(normalize);
  if (blues.includes(target)) return "Blue";
  if (reds.includes(target)) return "Red";
  return null;
}

function resultForUser(m, team) {
  const winnerRaw = m?.winner ?? m?.winningTeam ?? m?.result ?? m?.result_team ?? "";
  const winner = String(winnerRaw).toLowerCase();
  const teamNorm = String(team || "").toLowerCase();

  if (winner.includes("tie") || winner.includes("draw")) return "Tie";
  if (!winner || !teamNorm) return "Unknown";
  return winner === teamNorm ? "Win" : "Loss";
}

/* --------------------- main --------------------- */
module.exports = {
  name: "eloagainst",
  aliases: ["against", "elo_vs"],
  usage: "!eloagainst <name>",
  cooldownMs: 30_000,

  async run(message, deps) {
    const { elo, matchesStore, state } = deps || {};

    // ------------------ audit log ------------------
    try {
      const config = deps?.config;
      const channelId = config?.channels?.audit;
      if (message.client && channelId) {
        const auditCh = await message.client.channels.fetch(channelId).catch(() => null);
        if (auditCh && auditCh.isTextBased()) {
		await auditCh.send(
		  `📊 **ELOAGAINST** — <@${message.author.id}> ran \`!eloagainst ${message.content.split(/\s+/)[1] || ""}\` • ${formatTimestamp()}`
		);
        }
      }
    } catch (err) {
      console.warn("[eloagainst audit] failed:", err);
    }
    // ------------------------------------------------

    const uid = String(message.author?.id || "");
    const isDM = message.channel?.isDMBased?.() || message.channel?.type === 1;

    // --- Name lookup
    const arg = message.content.split(/\s+/)[1];
    if (!arg) {
      const msg = "Usage: `!eloagainst <name>`";
      return isDM ? message.channel.send(msg) : message.reply(msg);
    }

    const lookup = findPlayerIdByName(elo, arg);
    if (lookup.error) return isDM ? message.channel.send(lookup.error) : message.reply(lookup.error);
    const partnerId = lookup.id;
    const partnerName = lookup.name;

    // --- Load matches
    let allMatches = [];
    try {
      if (matchesStore?.getAll) allMatches = matchesStore.getAll();
      else if (matchesStore?.getRecent) allMatches = matchesStore.getRecent(1000);
      else if (state?.matches) allMatches = state.matches;
    } catch {}

    const byId = new Map();
    for (const m of toArr(allMatches)) {
      const id = String(m?.id || m?.matchId || "");
      if (id) byId.set(id, m);
    }

    // --- Elo rows for both players
    let eloRows = [];
    try {
      eloRows = elo.db
        .prepare(
          `SELECT match_id, before, after, delta, ts, player_id
           FROM rating_changes
           WHERE player_id IN (?, ?)
           ORDER BY ts DESC`
        )
        .all(uid, partnerId);
    } catch (e) {
      console.error("[eloagainst] elo query failed:", e);
    }

    // --- Group by match
    const byMatch = new Map();
    for (const r of eloRows) {
      const arr = byMatch.get(r.match_id) || [];
      arr.push(r);
      byMatch.set(r.match_id, arr);
    }

    const sharedRows = [];
    for (const [mid, arr] of byMatch.entries()) {
      const ids = new Set(arr.map((r) => String(r.player_id)));
      if (!ids.has(uid) || !ids.has(partnerId)) continue;

      const r = arr.find((x) => String(x.player_id) === uid);
      if (!r) continue;

      let m = byId.get(mid);
      if (!m) {
        try {
          const row = elo.db.prepare("SELECT * FROM matches WHERE match_id = ?").get(mid);
          if (row) m = row;
        } catch {}
      }
      if (!m) continue;

      // ensure opposite teams
      const myTeam = userTeam(m, uid);
      const theirTeam = userTeam(m, partnerId);
      if (!myTeam || !theirTeam || myTeam === theirTeam) continue;

      const result = resultForUser(m, myTeam);

      sharedRows.push({
        matchId: mid,
        date: isoFrom(r.ts),
        map: mapNameOf(m),
        result,
        before: r.before,
        delta: r.delta,
        after: r.after,
      });
    }

    // --- No shared matches
    if (!sharedRows.length) {
      const msg = `⚠️ You and **${partnerName}** have not played **against** each other yet.`;
      if (isDM) return message.channel.send(msg);
      else return message.reply(msg);
    }

    // --- Build embed summary
    const emb = new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle(`Elo History Against ${partnerName}`)
      .setDescription(`Recent head-to-head matches between you and **${partnerName}**`)
      .setTimestamp();

    const maxShown = 5;
    const shown = Math.min(sharedRows.length, maxShown);
    const extraNote = sharedRows.length > maxShown ? " (showing last 5)" : "";

    const list = sharedRows
      .slice(0, maxShown)
      .map((r, i) => {
        const sign = r.delta > 0 ? "🟢" : r.delta < 0 ? "🔴" : "⚪";
        const delta = r.delta > 0 ? `+${r.delta}` : r.delta;
        return `**#${i + 1}** — *${r.map}* — Elo: **${r.before} → ${r.after}** (${sign} ${delta})\nMatch: \`${r.matchId}\` • Result: ${r.result} • ${r.date}`;
      })
      .join("\n\n");

    emb.addFields({
      name: `Recent ${shown} of ${sharedRows.length} matches${extraNote}`,
      value: list || "No data available.",
    });

    const totalChange = sharedRows.reduce((sum, r) => sum + (r.delta || 0), 0);
    emb.addFields({
      name: "Overall Change",
      value: `${totalChange >= 0 ? "🟢 +" : "🔴 "}${totalChange}`,
      inline: false,
    });

    // --- CSV
    const csv = [
      "MatchId,Date,Map,Result,Before,Delta,After",
      ...sharedRows.map((r) =>
        [r.matchId, r.date, r.map, r.result, r.before, r.delta, r.after].join(",")
      ),
    ].join("\n");

    const attachment = new AttachmentBuilder(Buffer.from(csv, "utf8"), {
      name: `eloagainst_${partnerName}.csv`,
    });

    // --- Output
    try {
      if (isDM) {
        await message.channel.send({
          content: `Here’s your **head-to-head history** with **${partnerName}**:`,
          embeds: [emb],
          files: [attachment],
        });
      } else {
        const dm = await message.author.createDM();
        await dm.send({
          content: `Here’s your **head-to-head history** with **${partnerName}**:`,
          embeds: [emb],
          files: [attachment],
        });
      }
    } catch (e) {
      console.error("[eloagainst] DM failed:", e);
      if (!isDM) {
        await message.reply(
          `I couldn’t DM you your matches with ${partnerName}. Please enable DMs.`
        );
      }
    }
  },
};
