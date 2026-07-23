"use strict";

const TEAM1_STARTS_SETTING = "match:team1_starts";
const DEFAULT_TEAM1_STARTS = "offense";
const VALID_TEAM1_STARTS = new Set(["offense", "defense"]);

function isValidTeam1Starts(value) {
  return VALID_TEAM1_STARTS.has(String(value || "").trim().toLowerCase());
}

function normalizeTeam1Starts(value, fallback = DEFAULT_TEAM1_STARTS) {
  const normalized = String(value || "").trim().toLowerCase();
  if (VALID_TEAM1_STARTS.has(normalized)) return normalized;

  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  return VALID_TEAM1_STARTS.has(normalizedFallback)
    ? normalizedFallback
    : DEFAULT_TEAM1_STARTS;
}

function readTeam1Starts(settings) {
  return normalizeTeam1Starts(
    settings?.getString?.(TEAM1_STARTS_SETTING, DEFAULT_TEAM1_STARTS),
  );
}

function getTeamStartPlan(value) {
  const team1Starts = normalizeTeam1Starts(value);
  const team1StartsOffense = team1Starts === "offense";

  return {
    team1Starts,
    team2Starts: team1StartsOffense ? "defense" : "offense",
    round1: {
      blueTeam: "team1",
      redTeam: "team2",
      offenseTeam: team1StartsOffense ? "team1" : "team2",
      defenseTeam: team1StartsOffense ? "team2" : "team1",
    },
    round2: {
      blueTeam: team1StartsOffense ? "team2" : "team1",
      redTeam: team1StartsOffense ? "team1" : "team2",
      offenseTeam: team1StartsOffense ? "team2" : "team1",
      defenseTeam: team1StartsOffense ? "team1" : "team2",
    },
  };
}

function score(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function calculateMatchScores(h1 = {}, h2 = {}, value = DEFAULT_TEAM1_STARTS) {
  const team1Starts = normalizeTeam1Starts(value);

  // Preserve today's behavior when Team 1 starts offense: the rosters swap
  // physical colors for Round 2 because Blue is the attacking side.
  if (team1Starts === "offense") {
    return {
      totalBlue: score(h1.blue) + score(h2.red),
      totalRed: score(h1.red) + score(h2.blue),
    };
  }

  // On a compatible two-base map, defense-first keeps the rosters on their
  // physical colors: Red attacks Blue in Round 1, then Blue attacks Red.
  return {
    totalBlue: score(h1.blue) + score(h2.blue),
    totalRed: score(h1.red) + score(h2.red),
  };
}

function resolveTeam1Starts(requestedValue, map = {}, mode = "STANDARD") {
  const requested = normalizeTeam1Starts(requestedValue);
  const forcedValue =
    map?.forceTeam1Starts ??
    map?.force_team1_starts ??
    (String(mode || "").toUpperCase() === "ADL" ? "offense" : null);
  const forced = isValidTeam1Starts(forcedValue)
    ? normalizeTeam1Starts(forcedValue)
    : null;
  const team1Starts = forced || requested;

  return {
    requested,
    team1Starts,
    forced: Boolean(forced),
    overridden: Boolean(forced && forced !== requested),
    reason: forced
      ? String(mode || "").toUpperCase() === "ADL" &&
        map?.forceTeam1Starts == null &&
        map?.force_team1_starts == null
        ? "ADL maps require Blue/Team 1 to start offense"
        : `${map?.name || "This map"} requires Team 1 to start ${forced}`
      : null,
  };
}

function getTeamStartLockReason(state = {}) {
  if (
    state.voteLock ||
    state.isVoteStarting ||
    state.isVotingInProgress ||
    state.vote ||
    state.pendingTeam1Starts != null
  ) {
    return "vote";
  }
  return null;
}

function logicalTeamForPhysical(value, roundNumber, physicalTeam) {
  const plan = getTeamStartPlan(value);
  const round = Number(roundNumber) === 2 ? plan.round2 : plan.round1;
  return String(physicalTeam || "").toLowerCase() === "red"
    ? round.redTeam
    : round.blueTeam;
}

module.exports = {
  TEAM1_STARTS_SETTING,
  DEFAULT_TEAM1_STARTS,
  calculateMatchScores,
  getTeamStartLockReason,
  getTeamStartPlan,
  isValidTeam1Starts,
  logicalTeamForPhysical,
  normalizeTeam1Starts,
  readTeam1Starts,
  resolveTeam1Starts,
};
