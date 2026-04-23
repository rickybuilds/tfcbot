// lib/adl.js
"use strict";

/**
 * ADL vote tracker with on-disk persistence.
 * Exports:
 *  - vote(userId), unvote(userId), hasVoted(userId)
 *  - clearFor(userId), clearAll()
 *  - countVotes(currentIds?)
 *  - statusForCurrent(maxPlayers=8, requiredVotes=6, currentIds?)
 *  - shouldUseAdl(frozenIds, env=process.env)
 */

const fs = require("fs");
const path = require("path");

const PERSIST_FILE = path.resolve(process.cwd(), "adl_votes.json");

function readPersist() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return { votes: [] };
    const raw = fs.readFileSync(PERSIST_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.votes)) return { votes: data.votes };
  } catch {}
  return { votes: [] };
}
function writePersist(votesSet) {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ votes: Array.from(votesSet) }, null, 2));
  } catch {}
}

const _store = new Set(readPersist().votes);

// ---- core API ----
function vote(userId) {
  const id = String(userId);
  const before = _store.size;
  _store.add(id);
  if (_store.size !== before) writePersist(_store);
  return { added: true, total: _store.size };
}

function unvote(userId) {
  const id = String(userId);
  const had = _store.delete(id);
  if (had) writePersist(_store);
  return { removed: had, total: _store.size };
}

function hasVoted(userId) {
  return _store.has(String(userId));
}

function clearFor(userId) {
  return unvote(userId);
}

function clearAll() {
  _store.clear();
  writePersist(_store);
  return true;
}

/**
 * Count votes among a specific set of user IDs (e.g., the frozen lineup).
 * If currentIds is missing or not iterable, returns the global vote count.
 */
function countVotes(currentIds = null) {
  // guard: if not iterable, fall back to global count
  if (!currentIds || typeof currentIds[Symbol.iterator] !== "function") {
    return _store.size;
  }
  let n = 0;
  for (const id of currentIds) {
    if (_store.has(String(id))) n++;
  }
  return n;
}

/**
 * Human-friendly status for embeds.
 */
function statusForCurrent(maxPlayers = 8, requiredVotes = 6, currentIds = null) {
  const y = countVotes(currentIds);
  const need = Math.max(0, Number(requiredVotes) - y);
  if (y >= Number(requiredVotes)) {
    return `ADL armed (${y}/${requiredVotes}) — will use ADL map pool + 3× Elo`;
  }
  return `ADL votes ${y}/${requiredVotes} — need ${need} more`;
}

/**
 * Decide if ADL should be active for a specific frozen lineup.
 */
function shouldUseAdl(frozenIds = [], env = process.env) {
  // read from .env or fallback to 6
  const required = Number(env.ADL_REQUIRED_COUNT || 6);
  const votes = countVotes(frozenIds);
  return { useAdl: votes >= required, votes, required };
}


module.exports = {
  vote,
  unvote,
  hasVoted,
  clearFor,
  clearAll,
  countVotes,
  statusForCurrent,
  shouldUseAdl,
};
