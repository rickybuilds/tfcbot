// lib/autoArm.js
"use strict";

const { state } = require("./state");

/**
 * Arms auto-recap for HLDS log tracking
 */
async function autoArmFromMatchReady({ matchId, server, map, ttlMin = 90, teams }) {
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
    });

    console.log(`[autoArm] armed match ${matchId} (${map?.name || "unknown"}) on ${ip}:${portNum}, ttl=${ttlMin}m`);
  } catch (e) {
    console.error("[autoArm] failed to arm:", e);
    throw e;
  }
}

module.exports = { autoArmFromMatchReady };
