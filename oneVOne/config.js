"use strict";

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function loadOneVOneConfig() {
  return Object.freeze({
    enabled: bool("ONEVONE_ENABLED", false),
    dryRun: bool("ONEVONE_DRY_RUN", true),
    serverSetupEnabled: bool("ONEVONE_SERVER_SETUP_ENABLED", false),
    channelId: String(process.env.ONEVONE_CHANNEL_ID || process.env.PICKUP_CHANNEL_ID || ""),
    challengeTtlMs: positiveInt("ONEVONE_CHALLENGE_TTL_SECONDS", 180) * 1000,
    joinTimeoutMs: positiveInt("ONEVONE_JOIN_TIMEOUT_SECONDS", 300) * 1000,
    readyTimeoutMs: positiveInt("ONEVONE_READY_TIMEOUT_SECONDS", 300) * 1000,
    disconnectGraceMs: positiveInt("ONEVONE_DISCONNECT_GRACE_SECONDS", 120) * 1000,
    setupTimeoutMs: positiveInt("ONEVONE_SETUP_TIMEOUT_SECONDS", 60) * 1000,
    map: String(process.env.ONEVONE_MAP || "ass_dm"),
    killGoal: positiveInt("ONEVONE_KILL_GOAL", 50),
    roundsToWin: positiveInt("ONEVONE_ROUNDS_TO_WIN", 1),
  });
}

module.exports = { loadOneVOneConfig };
