// commands/reportMatch.js
"use strict";

const { guardChannel } = require("../lib/guards");
const elo = require("../lib/elo"); // EloDB handle
const { getTeamsFromMatches, formatMatchEmbed } = require("./matches");
const { BanStore } = require("../lib/banStore");

// Create or reuse one BanStore instance
const banStore = new BanStore("bot.db");

/* ---------------------------- fetchTeams helper ---------------------------- */
function fetchTeams(matchId) {
  try {
    const fromMatches = getTeamsFromMatches(matchId);
    if ((fromMatches.blue?.length || 0) > 0 || (fromMatches.red?.length || 0) > 0) {
      return fromMatches;
    }

    // fallback: rebuild from rating_changes
    const rows = elo.db.prepare(`
      SELECT player_id, before
      FROM rating_changes
      WHERE match_id=?
    `).all(String(matchId));

    const blueTeam = [];
    const redTeam = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const player = {
        id: String(r.player_id),
        name: String(r.player_id),
        before: r.before || 1941,
      };
      if (i % 2 === 0) blueTeam.push(player);
      else redTeam.push(player);
    }
    return { blue: blueTeam, red: redTeam, meta: {} };
  } catch (e) {
    console.error("[fetchTeams]", e);
    return { blue: [], red: [], meta: {} };
  }
}

/* ================================ register ================================ */
function register(registry, { config }) {
  registry.set("reportmatch", async (message, args) => {
    if (!(await guardChannel(message, config.channels.pickup))) return;

    const [matchId, outcomeRaw] = args;
    if (!matchId || !outcomeRaw) {
      return message.channel.send("Usage: `!reportmatch <matchId> <blue|red|tie>`");
    }

    const outcome = String(outcomeRaw).toLowerCase();
    if (!["blue", "red", "tie"].includes(outcome)) {
      return message.channel.send("Outcome must be one of: `blue`, `red`, `tie`.");
    }

    try {
      const { blue, red, meta } = fetchTeams(matchId);
      if (blue.length === 0 && red.length === 0) {
        return message.channel.send(`⚠️ Match ID \`${matchId}\` not found or has no players.`);
      }

      /* ------------------------- DB: ensure match row ------------------------- */
      elo.db.prepare(`
        INSERT INTO matches (match_id, map_name, created_at, status)
        VALUES (?, ?, ?, 'pending')
        ON CONFLICT(match_id) DO NOTHING
      `).run(matchId, meta.map || "unknown", Math.floor(Date.now() / 1000));

      elo.db.prepare(`
        UPDATE matches
        SET winner=?, status='completed'
        WHERE match_id=?
      `).run(outcome, matchId);

      /* ------------------------- RNG + Streak Multiplier ---------------------- */
      let streakMult = 1.0;
      const allPlayers = [...blue, ...red];
      for (const p of allPlayers) {
        const sm = elo.getStreakMultiplier(p.id);
        if (sm > streakMult) streakMult = sm;
      }

      const rngMult = Math.max(meta.rng_multiplier || 1.0, streakMult);

      /* ----------------------------- Elo updates ------------------------------ */
      const results = elo.applyTeamResult({
        matchId,
        blue,
        red,
        winner: outcome,
        createdAt: meta.createdAt || Date.now(),
        match: {
          mode: meta.mode || "STANDARD",
          rng_multiplier: rngMult,
        },
      });

      /* --------------------------- Decrement Bans ----------------------------- */
      for (const p of allPlayers) {
        const res = banStore.decrementBan(p.id);
        if (res) {
          console.log(`[banStore] ${p.id} decremented to ${res.gamesRemaining} games remaining.`);
        } else {
          console.log(`[banStore] ${p.id} unbanned (ban expired or not found).`);
        }
      }

      /* ------------------------- Confirmation Embed --------------------------- */
      const emb = formatMatchEmbed(
        matchId,
        outcome,
        { ...meta, rng_multiplier: rngMult },
        results.blue,
        results.red,
        results.avgBlue,
        results.avgRed
      );

       await message.channel.send({ embeds: [emb] });

      /* --------------------------- Unlock after report --------------------------- */
      try {
        const { attachAutoRecap } = require("../services/autoRecap");
        const recap = attachAutoRecap({ client: message.client }); // fresh hook to recap service
        recap.disarmByMatchId(matchId); // unlock players + server
        console.log(`[reportmatch] ✅ AutoRecap disarmed for ${matchId}`);
      } catch (err) {
        console.warn(`[reportmatch] ⚠️ Failed to auto-unlock for ${matchId}:`, err);
      }

    } catch (e) {
      console.error("[reportmatch]", e);
      await message.channel.send("Error reporting match.");
    }
  });
} 

module.exports = { register };
