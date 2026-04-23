// lib/state.js
"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");

/**
 * 🧠 Global Singleton Pattern
 * Ensures all modules share the same state instance (no duplicate copies)
 */
if (!global.__tfcState) {
  console.log("[STATE] Initializing global shared state");

  global.__tfcState = {
    MAX_PLAYERS: Number(config.MAX_PLAYERS) || 8,
    queue: [],
    vote: null,
    queueSnapshot: null,
    serverWinner: null,
    matches: [],
    servers: [],
    maps: [],
    adlMaps: [],
    showVoters: true,
	voteLock: false,
    locks: {
      servers: {}, // 🔒 shared live lock map for all modules
      players: {},
    },
    lockedServers: new Set(), // legacy fallback
    lockedPlayers: new Map(),
    ghostBans: {},
  };
}

// Always export the global reference
const state = global.__tfcState;

const SERVERS_PATH = path.resolve(process.cwd(), "servers.json");
const MAPPOOL_PATH = path.resolve(process.cwd(), "mappool.json");
const ADL_MAPPOOL_PATH = path.resolve(process.cwd(), "mappool_adl.json");

/** Load regular server list */
function loadServersFile() {
  try {
    const raw = fs.readFileSync(SERVERS_PATH, "utf8");
    const arr = JSON.parse(raw);

    state.servers = (Array.isArray(arr) ? arr : [])
      .filter(s => s && s.name && s.ip)
      .map((s, i) => ({
        id: String(i + 1),
        name: String(s.name),
        ip: String(s.ip),
        password: s.password ? String(s.password) : "",
        url: s.url ? String(s.url) : null,
      }));

    console.log(`[loadServersFile] Loaded ${state.servers.length} servers:`);
    for (const srv of state.servers) {
      console.log(`  - ${srv.name} (${srv.ip}) ${srv.url ? "→ " + srv.url : ""}`);
    }

    return true;
  } catch (e) {
    console.error("[loadServersFile] failed:", e.message);
    state.servers = [];
    return false;
  }
}

/** Load regular mappool */
function loadMappoolFile() {
  try {
    const raw = fs.readFileSync(MAPPOOL_PATH, "utf8");
    const arr = JSON.parse(raw);
    state.maps = Array.isArray(arr)
      ? arr.map(m => ({
          key: m.key,
          name: m.name,
          tier: Number(m.tier) || 0,
         mirv: Number(m.mirv) || 0,   // ✅ ADD THIS LINE
          author: m.author || "",
        }))
      : [];
    return true;
  } catch (e) {
    console.error("[loadMappoolFile] failed:", e.message);
    state.maps = [];
    return false;
  }
}

/** Load ADL mappool */
function loadAdlMappoolFile() {
  try {
    const raw = fs.readFileSync(ADL_MAPPOOL_PATH, "utf8");
    const arr = JSON.parse(raw);
    state.adlMaps = Array.isArray(arr)
      ? arr.map(m => ({
          key: m.key || m.name,
          name: m.name,
          mirv: Number(m.mirv) || 0,  // ✅ read actual "mirv" now
          author: m.author || "",
        }))
      : [];
    console.log(`[loadAdlMappoolFile] Loaded ${state.adlMaps.length} ADL maps`);
    return true;
  } catch (e) {
    console.error("[loadAdlMappoolFile] failed:", e.message);
    state.adlMaps = [];
    return false;
  }
}

/** Force-unlock a server if it’s stuck in a locked state */
function unlockServer(serverIp) {
  if (!serverIp) return false;

  const { locks, lockedServers } = state;
  let changed = false;

  // remove from live lock map
  if (locks?.servers?.[serverIp]) {
    delete locks.servers[serverIp];
    changed = true;
  }

  // remove from legacy set
  if (lockedServers?.has(serverIp)) {
    lockedServers.delete(serverIp);
    changed = true;
  }

  if (changed)
    console.log(`[STATE] ✅ Force-unlocked server ${serverIp}`);
  else
    console.log(`[STATE] ℹ️ Server ${serverIp} was not locked.`);

  return changed;
}


module.exports = { state, loadServersFile, loadMappoolFile, loadAdlMappoolFile, unlockServer };
