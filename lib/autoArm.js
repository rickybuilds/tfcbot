// lib/autoArm.js
"use strict";

const { state } = require("./state");
const { normalizeTeam1Starts } = require("./teamStart");

/**
 * Arms auto-recap for HLDS log tracking
 */
async function autoArmFromMatchReady({
  matchId,
  server,
  map,
  ttlMin = 90,
  teams,
  team1Starts,
  team1StartsForced = false,
  team1StartsReason = null,
}) {
  try {
    if (!matchId) throw new Error("Missing matchId");

    const ip = server?.ip || "unknown";
    const portNum = Number(server?.port || 27015);

    // ✅ Arm via autoRecap if it exists
    state.autoRecap?.armFromMatchReady?.({
      matchId,
      serverIp: ip,
      port: portNum,
      map: map?.name || "(unknown)",
      ttlMin,
      teams, // 👈 pass Blue/Red Discord IDs
      team1Starts: normalizeTeam1Starts(team1Starts),
      team1StartsForced: Boolean(team1StartsForced),
      team1StartsReason,
    });

    // Track in state for quick lookups
    state.matches = state.matches || [];
    state.matches.unshift({
      id: matchId,
      createdAt: Date.now(),
      map: map?.name || "(unknown)",
      server: ip,
      port: portNum,
      pending: true,
      teams, // 👈 keep in memory too
      team1Starts: normalizeTeam1Starts(team1Starts),
      team1StartsForced: Boolean(team1StartsForced),
      team1StartsReason,
    });
    if (state.matches.length > 50) state.matches.length = 50;

    console.log(`[autoArm] armed match ${matchId} (${map?.name || "unknown"}) on ${ip}:${portNum}, ttl=${ttlMin}m`);
  } catch (e) {
    console.error("[autoArm] failed to arm:", e);
    throw e;
  }
}

module.exports = { autoArmFromMatchReady };
