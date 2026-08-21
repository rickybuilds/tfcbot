// lib/odds.js
"use strict";
const { EmbedBuilder } = require("discord.js");
const { getStoredPlayerName } = require("./util");

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const logisticProb = (diff) => 1 / (1 + Math.pow(10, -diff / 400));
const idOf   = (p) => String(p.id ?? p.userId ?? p.user_id ?? "");
const nameOf = (p, elo = null) => getStoredPlayerName(
  elo,
  idOf(p),
  p.name ?? p.display_name ?? p.username ?? p.tag ?? p.id ?? "Unknown"
);

/**
 * Fetch Elo rating from DB using EloDB handle.
 * 1. Try player_id
 * 2. If no row, try display_name
 * 3. Fall back to START_RATING (1941)
 */
function getRating(elo, p) {
  try {
    const pid = idOf(p);

    // always try player_id first
    const row = elo?.db?.prepare("SELECT rating FROM ratings WHERE player_id = ?").get(pid);
    if (row && row.rating != null) return Number(row.rating);

    // fallback to display_name
    const row2 = elo?.db?.prepare("SELECT rating FROM ratings WHERE display_name = ?").get(nameOf(p, elo));
    if (row2 && row2.rating != null) return Number(row2.rating);

    // default if not found
    return 1941;
  } catch (e) {
    // silent fallback
    return 1941;
  }
}

/**
 * Rebuild full player objects from arrays of IDs
 * using the Elo ratings DB.
 */
function buildTeamObjects(ids, elo) {
  if (!Array.isArray(ids)) return [];

  return ids.map(id => {
    try {
      const row = elo.db
        .prepare("SELECT display_name AS name, rating FROM ratings WHERE player_id=?")
        .get(id);

      return {
        id: String(id),
        name: row?.name || "Unknown",
        elo: row?.rating != null ? Number(row.rating) : 1941,
      };
    } catch (e) {
      return { id: String(id), name: "Unknown", elo: 1941 };
    }
  });
}


// ----- odds card -----
function computeOdds(avgBlue, avgRed) {
  const diff = (Number(avgBlue) || 0) - (Number(avgRed) || 0);
  const pBlue = logisticProb(diff);

  const sweepBlue = clamp(0.30 + diff / 1000, 0.20, 0.70);
  const sweepRed  = clamp(0.30 - diff / 1000, 0.20, 0.70);

  const options = [
    { label: "Blue win 2–0", prob: pBlue * sweepBlue },
    { label: "Blue win 2–1", prob: pBlue * (1 - sweepBlue) },
    { label: "Red win 2–1",  prob: (1 - pBlue) * (1 - sweepRed) },
    { label: "Red win 2–0",  prob: (1 - pBlue) * sweepRed },
  ];

  const sum = options.reduce((a, o) => a + o.prob, 0) || 1;
  options.forEach(o => { o.prob /= sum; o.pct = Math.round(o.prob * 100); });
  return options.sort((a, b) => b.prob - a.prob);
}

function buildOddsEmbed({ serverName, mapName, matchId, ip, avgBlue, avgRed }) {
  const options = computeOdds(avgBlue, avgRed);
  const delta = Math.abs((avgBlue || 0) - (avgRed || 0));

  const lines = options
    .map((o, i) => `**${i + 1}) ${i === 0 ? "✅ " : ""}${o.label} — ${o.pct}%**`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle(`Odds — ${serverName || "Unknown Server"} — ${mapName || "Unknown Map"}`)
    .setDescription(
      `**Match:** ${matchId}` +
      (ip ? `\n**Server IP:** ${ip}` : "") +
      `\nShowing 4 options (✅ = picked)`
    )
    .addFields(
      { name: "Team Averages", value: `Blue ${avgBlue ?? "?"} — Red ${avgRed ?? "?"} (Δ ${delta})`, inline: false },
      { name: "Options", value: lines, inline: false },
    )
    .setTimestamp();
}

// ----- team scenarios -----
function summarizeSplit(blue, red, ratings) {
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const bAvg = Math.round(sum(blue, (p) => ratings.get(idOf(p))) / Math.max(1, blue.length));
  const rAvg = Math.round(sum(red,  (p) => ratings.get(idOf(p))) / Math.max(1, red.length));
  const pBlue = logisticProb(bAvg - rAvg);
  return { avgBlue: bAvg, avgRed: rAvg, pBlue, pctBlue: Math.round(pBlue * 100), pctRed: 100 - Math.round(pBlue * 100) };
}

function greedySplitBalanced(players, ratings) {
  const blueCap = Math.ceil(players.length / 2);
  const redCap  = players.length - blueCap;

  const sorted = [...players].sort((a, b) => ratings.get(idOf(b)) - ratings.get(idOf(a)));
  const blue = [], red = [];
  let sB = 0, sR = 0;

  for (const p of sorted) {
    const r = ratings.get(idOf(p)) || 0;
    if (blue.length >= blueCap) { red.push(p); sR += r; continue; }
    if (red.length >= redCap) { blue.push(p); sB += r; continue; }
    if (sB <= sR) { blue.push(p); sB += r; } else { red.push(p); sR += r; }
  }
  return { blue, red };
}

function generateFairScenarios(players, elo, max = 4) {
  const ratings = new Map(players.map((p) => [idOf(p), getRating(elo, p)]));
  const base = greedySplitBalanced(players, ratings);

  const scenarios = [];
  const seen = new Set();
  const keyForBlue = (blue) => [...blue].map(idOf).sort().join("|");

  function push(blue, red) {
    const key = keyForBlue(blue);
    if (seen.has(key)) return;
    seen.add(key);
    const s = summarizeSplit(blue, red, ratings);
    scenarios.push({ blue: [...blue], red: [...red], ...s, score: Math.abs(s.avgBlue - s.avgRed) });
  }

  push(base.blue, base.red);

  for (const b of base.blue) {
    for (const r of base.red) {
      const B = [...base.blue]; const R = [...base.red];
      const bi = B.findIndex(x => idOf(x) === idOf(b));
      const ri = R.findIndex(x => idOf(x) === idOf(r));
      if (bi < 0 || ri < 0) continue;
      B[bi] = r; R[ri] = b;
      push(B, R);
    }
  }

  return scenarios.sort((a, b) => a.score - b.score || b.pBlue - a.pBlue).slice(0, max);
}

/**
 * Build the numbered list shown in the odds channel. Scenario 1 is always
 * the assigned teams, followed by the fairest alternative splits.
 */
function buildMatchScenarios(actualBlue, actualRed, players, elo, maxAlternatives = 4) {
  const ratings = new Map(players.map((p) => [idOf(p), getRating(elo, p)]));
  const actual = {
    blue: [...actualBlue],
    red: [...actualRed],
    ...summarizeSplit(actualBlue, actualRed, ratings),
  };
  actual.score = Math.abs(actual.avgBlue - actual.avgRed);

  const scenarios = [actual];
  const actualKey = keyForTeam(actualBlue);
  for (const scenario of generateFairScenarios(players, elo, maxAlternatives)) {
    if (keyForTeam(scenario.blue) !== actualKey) scenarios.push(scenario);
  }
  return scenarios;
}

function keyForTeam(team) {
  return team.map(idOf).sort().join("|");
}

function buildTeamScenariosEmbed({
  matchId,
  serverName,
  ip,
  mapName,
  scenarios,
  kFactor = 32,
  elo,
  match = {},   // ✅ safe default
}) {
  const rngMult = match?.rng_multiplier || 1.0;  // ✅ safe access
  const effectiveK = Math.round(kFactor * rngMult);

  const lines = [];
  lines.push(`**Match:** ${matchId}${ip ? ` — ${ip}` : ""}`);
  lines.push(
    `Showing up to **4 fairest splits** by Elo.` +
    (rngMult !== 1.0 ? `\n🔥 Multiplier Active: **${rngMult}× Elo**` : "")
  );

  scenarios.forEach((s, i) => {
    const header = i === 0 ? `**Scenario ${i + 1}** (✅ Actual Teams)` : `Scenario ${i + 1}`;
    const blueNames = s.blue.map(p => `${nameOf(p, elo)} (${getRating(elo, p)})`).join(", ");
    const redNames  = s.red .map(p => `${nameOf(p, elo)} (${getRating(elo, p)})`).join(", ");

    lines.push(header);
    lines.push(
      `Elo Avg — **Blue ${s.avgBlue}**, **Red ${s.avgRed}** · ` +
      `Win% — **Blue ${s.pctBlue}%**, **Red ${s.pctRed}%**`
    );
    lines.push(`**🔵Blue:** ${blueNames}`);
    lines.push(`**🔴Red:** ${redNames}`);
    lines.push("");
  });

  return new EmbedBuilder()
    .setColor(0x00a3ff)
    .setTitle(`🏷️ Team Scenarios — ${serverName || "Unknown Server"} — ${mapName || "Unknown Map"}`)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

module.exports = { 
  generateFairScenarios,
  buildMatchScenarios,
  buildTeamScenariosEmbed,
  computeOdds,
  buildOddsEmbed,
  getRating,
  summarizeSplit,
  buildTeamObjects  // ✅ NEW
};
