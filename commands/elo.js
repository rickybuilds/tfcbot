// commands/elo.js
"use strict";

const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const { WinStreakStore } = require("../lib/winstreak");

/* ---------------- Rank bands ---------------- */
const RANKS_ASC = [
  { rank: "1",  min: 300,  max: 720 },
  { rank: "2",  min: 721,  max: 1050 },
  { rank: "3",  min: 1051, max: 1390 },
  { rank: "4",  min: 1391, max: 1640 },
  { rank: "5",  min: 1641, max: 2000 },
  { rank: "6",  min: 2001, max: 2460 },
  { rank: "7",  min: 2461, max: 2730 },
  { rank: "8",  min: 2731, max: 3010 },
  { rank: "9",  min: 3011, max: 3200 },
  { rank: "10", min: 3201, max: 3599 },
  { rank: "S",  min: 3600, max: Infinity },
];

function nextRankGap(elo) {
  for (let i = 0; i < RANKS_ASC.length; i++) {
    const r = RANKS_ASC[i];
    if (elo >= r.min && elo <= r.max) {
      const next = RANKS_ASC[Math.min(i + 1, RANKS_ASC.length - 1)];
      if (r.name === "S") return { band: "S", next: "S", need: 0 };
      return { band: r.name, next: next.name, need: Math.max(0, next.min - elo) };
    }
  }
  return { band: RANKS_ASC[0].name, next: RANKS_ASC[0].name, need: 0 };
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const safeName = (msg) =>
  msg.member?.displayName || msg.author?.globalName || msg.author?.username || "Unknown";

function formatMapCounts(mapCounts) {
  if (!mapCounts.size) return "_none yet_";
  const arr = [...mapCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return arr.map(([m, c]) => `• ${m} — ${c}`).join("\n");
}

/* ---------------- fetch user history ---------------- */
function getUserHistory(elo, userId) {
  try {
    if (elo.db?.prepare) {
      const stmt = elo.db.prepare(`
        SELECT rc.ts, rc.before, rc.after, rc.delta, rc.match_id,
               m.status, m.map_name, m.blue_ids, m.red_ids, m.winner
          FROM rating_changes rc
          LEFT JOIN matches m ON m.match_id = rc.match_id
         WHERE rc.player_id = ?
           AND rc.match_id NOT LIKE 'admin-%'
           AND rc.match_id NOT LIKE 'seed-%'
         ORDER BY rc.ts ASC
      `);
      return stmt.all(String(userId));
    }
  } catch (e) {
    console.error("[getUserHistory] failed:", e);
  }
  return [];
}

/* ---------------- active 30-day leaderboard rank ---------------- */
async function getActiveRank(elo, userId) {
  try {
    if (!elo?.db?.prepare) return null;
    const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;

    const rows = elo.db.prepare(`
      SELECT r.player_id AS id,
             COALESCE(r.display_name,'') AS name,
             r.rating AS rating,
             COUNT(c.id) AS games30,
             MAX(c.ts)  AS last_ts
        FROM ratings r
        JOIN rating_changes c ON c.player_id = r.player_id AND c.ts >= ?
       GROUP BY r.player_id
       ORDER BY r.rating DESC
    `).all(cutoff);

    if (!rows.length) return null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].id) === String(userId)) {
        return { rank: i + 1, total: rows.length, rating: Math.round(rows[i].rating) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------- QuickChart builder ------------- */
async function buildChartPng(rows) {
  if (!rows.length) return null;

  const labels = rows.map((_, i) => i + 1);
  const data = rows.map(r => Number(r.after));

  const minY = Math.min(...data);
  const maxY = Math.max(...data);
  const pad = Math.max(25, Math.round((maxY - minY) * 0.2)) || 50;
  const pointRadius = data.map((_, i) => (i === data.length - 1 ? 3 : 0));

  const chartConfig = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          tension: 0.35,
          borderColor: "#4da6ff",
          backgroundColor: "rgba(77,166,255,0.12)",
          borderWidth: 2.5,
          fill: true,
          pointRadius,
          pointHoverRadius: 5,
          pointHitRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, title: { display: false } },
      layout: { padding: { left: 16, right: 16, top: 12, bottom: 12 } },
      scales: {
        x: {
          grid: { color: "rgba(229,231,235,0.08)", display: false, },
          ticks: { color: "#e5e7eb" },
        },
        y: {
          grid: { color: "rgba(229,231,235,0.08)" },
          ticks: { color: "#e5e7eb", precision: 0 },
          suggestedMin: minY - pad,
          suggestedMax: maxY + pad,
        },
      },
    },
  };

  const url =
    "https://quickchart.io/chart?format=png&width=1100&height=520&backgroundColor=" +
    encodeURIComponent("#121417") +
    "&v=4&c=" +
    encodeURIComponent(JSON.stringify(chartConfig));

  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return new AttachmentBuilder(buf, { name: "elo_chart.png" });
}

function computeCurrentStreak(matchRows, userId) {
  let streak = 0;
  for (let i = matchRows.length - 1; i >= 0; i--) {
    const r = matchRows[i];
    let team = null;
    try {
      const blueIds = JSON.parse(r.blue_ids || "[]");
      const redIds = JSON.parse(r.red_ids || "[]");
      if (blueIds.includes(userId)) team = "BLUE";
      else if (redIds.includes(userId)) team = "RED";
    } catch {}
    const outcome = (r.winner || "").toLowerCase();
    if (!team || !["blue", "red"].includes(outcome)) break;
    if (outcome === team.toLowerCase()) streak++;
    else break;
  }
  return streak;
}

/* --------------------------- command registration -------------------------- */
function register(registry, deps) {
  const { state, elo, matchesStore } = deps;

  registry.set("elo", async (message) => {
	      const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID || "";
    const auditLog = async (content) => {
      try {
        if (!AUDIT_CHANNEL_ID || !message.client.channels.cache.has(AUDIT_CHANNEL_ID)) return;
        const ch = await message.client.channels.fetch(AUDIT_CHANNEL_ID);
        if (ch) await ch.send(content);
      } catch (err) {
        console.error("[!elo audit log] failed:", err);
      }
    };
    try {
	  await auditLog(
	  `📊 <@${message.author.id}> ran \`!elo\` in **${message.guild?.name || "DM"}** at <t:${Math.floor(Date.now()/1000)}:T>`
	);
      const userId = String(message.author.id);
      const display = safeName(message);

      const currentElo = Math.round(
        Number(
          typeof elo.peekRating === "function"
            ? elo.peekRating(userId, 1200)
            : elo.getRating(userId, display, { createIfMissing: false })
        ) || 1200
      );

      const allRows = getUserHistory(elo, userId);

      const matchRows = allRows.filter((r) => {
        if (!r.match_id || r.status !== "completed") return false;
        if (String(r.match_id).startsWith("seed-")) return false;
        if (String(r.match_id).startsWith("admin")) return false;
        return true;
      });

      const games = matchRows.length;

      let w = 0,
        l = 0,
        t = 0;
      for (const r of matchRows) {
        let team = null;
        try {
          const blueIds = JSON.parse(r.blue_ids || "[]");
          const redIds = JSON.parse(r.red_ids || "[]");
          if (blueIds.includes(userId)) team = "BLUE";
          else if (redIds.includes(userId)) team = "RED";
        } catch {}
        const outcome = (r.winner || "").toLowerCase();
        if (outcome === "tie") t++;
        else if (team && outcome === team.toLowerCase()) w++;
        else if (team && ["blue", "red"].includes(outcome)) l++;
      }

      const peakElo = games
        ? Math.max(...matchRows.map((r) => Math.round(Number(r.after) || 0)))
        : currentElo;
      const last = matchRows[matchRows.length - 1] || null;
      const lastDelta = last ? Math.round(Number(last.delta) || 0) : 0;
      const lastWhen = last ? `<t:${Math.floor(Number(last.ts) || 0)}:R>` : "—";
      const bandInfo = nextRankGap(currentElo);

      const mapCounts = new Map();
      for (const r of matchRows) {
        if (r.map_name) mapCounts.set(r.map_name, (mapCounts.get(r.map_name) || 0) + 1);
      }

      const active = await getActiveRank(elo, userId);
      const streak = computeCurrentStreak(matchRows, userId);
      const currentStreakLabel = streak > 0 ? `W${streak}` : "—";

      // Chart only if games exist
      let chartPng = null;
      if (games > 0) {
        //chartPng = await buildChartPng(matchRows, currentElo - (lastDelta || 0));
		//chartPng = await buildChartPng(matchRows, currentElo);
		chartPng = await buildChartPng(matchRows);
      }

      const embStats = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`${display}'s Stats — Rank: ${bandInfo.band}`)
        .addFields(
          {
            name: "Leaderboard Ranking (last 30 days)",
            value: active ? `${active.rank} of ${active.total}` : "—",
          },
          {
            name: "ELO & Record",
            value:
              `**Elo Band:** ${bandInfo.band}${
                bandInfo.need ? ` _(need ${bandInfo.need} for ${bandInfo.next})_` : ""
              }\n` +
              `**Current Elo:** ${currentElo}\n` +
              `**Games:** ${games}\n` +
              `**W/L/T:** ${w}/${l}/${t} (**${pct(w, games)}%** / **${pct(l, games)}%** / **${pct(t, games)}%**)`,
          },
          {
            name: "Last Game",
            value: last
              ? `Δ \`${signed(lastDelta)}\` → **${Math.round(
                  Number(last.after) || currentElo
                )}** · ${lastWhen}`
              : "_no games yet_",
          },
          { name: "Peak Elo", value: `${peakElo}`, inline: true },
          { name: "Current Streak", value: currentStreakLabel, inline: true },
          { name: "Most Played Maps", value: formatMapCounts(mapCounts) }
        )
        .setTimestamp();

      const embeds = [embStats];
      const files = [];

      if (chartPng) {
        const embChart = new EmbedBuilder()
          .setColor(0x8b5cf6)
          .setImage("attachment://elo_chart.png")
          .setTimestamp();
        embeds.push(embChart);
        files.push(chartPng);
      }

      const dm = await message.author.createDM();
      await dm.send({ embeds, files });

      if (message.guild) {
        try {
          await message.delete();
        } catch {}
      }
    } catch (e) {
      console.error("[!elo DM] failed:", e);
      if (message.guild) {
        try {
          await message.reply(
            "I couldn’t DM you your Elo stats. Enable DMs from server members and try `!elo` again."
          );
        } catch {}
      }
    }
  });
}

module.exports = { register };
