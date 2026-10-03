// lib/offense.js
"use strict";

// Full-time offense players ride along with a pickup without being part of
// its official roster. They never count toward MAX_PLAYERS, never vote, and
// are kept out of blue_ids/red_ids so every Elo, streak, and stats path that
// reads those columns ignores them.

const OFFENSE_MAX_PER_TEAM_SETTING = "offense:max_per_team";
const DEFAULT_OFFENSE_MAX_PER_TEAM = 1;
const MAX_OFFENSE_PER_TEAM_LIMIT = 4;

function offenseMaxPerTeam(settings) {
  let n = DEFAULT_OFFENSE_MAX_PER_TEAM;
  try {
    if (typeof settings?.getNumber === "function") {
      n = Number(settings.getNumber(OFFENSE_MAX_PER_TEAM_SETTING, DEFAULT_OFFENSE_MAX_PER_TEAM));
    }
  } catch {}
  if (!Number.isFinite(n)) n = DEFAULT_OFFENSE_MAX_PER_TEAM;
  return Math.max(0, Math.min(MAX_OFFENSE_PER_TEAM_LIMIT, Math.floor(n)));
}

function offenseCapacity(settings) {
  return offenseMaxPerTeam(settings) * 2;
}

/**
 * When OFFENSE_ROLE_ID is configured, only members holding that role (or the
 * admin role) may add as full-time offense. Without it, anyone may.
 */
function canAddAsOffense(member, config) {
  const roleId = String(config?.roles?.offense || "").trim();
  if (!roleId) return true;
  const roles = member?.roles?.cache;
  if (!roles?.has) return false;
  const adminRole = String(config?.roles?.admin || "").trim();
  return roles.has(roleId) || Boolean(adminRole && roles.has(adminRole));
}

function ensureOffenseQueue(state) {
  if (!Array.isArray(state.offenseQueue)) state.offenseQueue = [];
  return state.offenseQueue;
}

function isOffensePlayer(state, id) {
  return ensureOffenseQueue(state).some(p => String(p.id) === String(id));
}

function removeFromOffense(state, id) {
  const list = ensureOffenseQueue(state);
  const next = list.filter(p => String(p.id) !== String(id));
  state.offenseQueue = next;
  return next.length !== list.length;
}

/**
 * Splits waiting offense players across the two teams in join order,
 * alternating sides so neither team gets more than one extra attacker.
 * Players excluded (already on the roster) or locked into another match
 * stay waiting for the next pickup, as do any beyond the per-team cap.
 */
function assignOffensePlayers(
  offenseQueue,
  { excludeIds = [], lockedPlayers = null, maxPerTeam = DEFAULT_OFFENSE_MAX_PER_TEAM, random = Math.random } = {}
) {
  const excluded = new Set([...excludeIds].map(String));
  const cap = Math.max(0, Math.floor(Number(maxPerTeam) || 0));
  const blue = [];
  const red = [];
  const remaining = [];
  let next = random() < 0.5 ? "blue" : "red";

  for (const player of offenseQueue || []) {
    const id = String(player.id);
    if (excluded.has(id)) continue; // already playing as a regular; drop the offense entry
    if (lockedPlayers?.has?.(id)) {
      remaining.push(player);
      continue;
    }

    const target = next === "blue" ? blue : red;
    const other = next === "blue" ? red : blue;
    if (target.length < cap) {
      target.push(player);
      next = next === "blue" ? "red" : "blue";
    } else if (other.length < cap) {
      other.push(player);
    } else {
      remaining.push(player);
    }
  }

  return { blue, red, remaining };
}

module.exports = {
  OFFENSE_MAX_PER_TEAM_SETTING,
  DEFAULT_OFFENSE_MAX_PER_TEAM,
  MAX_OFFENSE_PER_TEAM_LIMIT,
  offenseMaxPerTeam,
  offenseCapacity,
  canAddAsOffense,
  ensureOffenseQueue,
  isOffensePlayer,
  removeFromOffense,
  assignOffensePlayers,
};
