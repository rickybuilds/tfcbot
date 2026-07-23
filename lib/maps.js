// lib/maps.js
"use strict";

const fs = require("fs");
const path = require("path");
const { randomInt } = require("crypto");

// Paths
const ROOT = process.cwd();
const MAP_JSON = path.resolve(ROOT, "mappool.json");
const MAP_TXT  = path.resolve(ROOT, "mappool.txt");

// util: mirv label
function mirvLabel(mirv) {
  const n = Number.isFinite(+mirv) ? +mirv : 0;
  return `${n} mirv${n === 1 ? "" : "s"}`;
}

// ---- basic storage helpers ----
function _readJson() {
  try {
    if (fs.existsSync(MAP_JSON)) {
      const raw = fs.readFileSync(MAP_JSON, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(normMap);
    }
  } catch (e) {
    console.error("[maps] read JSON failed:", e);
  }
  return [];
}

function _writeJson(arr) {
  try {
    fs.writeFileSync(MAP_JSON, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("[maps] write JSON failed:", e);
  }
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function makeKey(name) {
  const base = slug(name) || "map";
  const salt = randomInt(0x1000, 0xffff).toString(16);
  return `${base}-${salt}`;
}

function normMap(m) {
  // Ensure {key,name,mirv,tier}, preserving an optional starting-order rule.
  const key = m.key || makeKey(m.name || "map");
  const name = String(m.name || m.key || "map");
  const mirv = Number.isFinite(+m.mirv) ? +m.mirv : 0;
  const tier = Number.isFinite(+m.tier) ? +m.tier : 0;
  const forceTeam1Starts =
    m.forceTeam1Starts || m.force_team1_starts || null;
  return {
    key,
    name,
    mirv,
    tier,
    ...(forceTeam1Starts ? { forceTeam1Starts } : {}),
  };
}

// One-time migration from mappool.txt → mappool.json if json is missing
function migrateFromTxtIfNeeded() {
  if (fs.existsSync(MAP_JSON)) return;
  if (!fs.existsSync(MAP_TXT)) return;

  try {
    const raw = fs.readFileSync(MAP_TXT, "utf8");
    const seen = new Set();
    const out = [];

    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split(/\s+/);
      const name = parts[0];
      const mirv = Number.isFinite(parseInt(parts[1], 10)) ? parseInt(parts[1], 10) : 0;
      const tier = Number.isFinite(parseInt(parts[2], 10)) ? parseInt(parts[2], 10) : 0;

      // avoid dup names on migration
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      out.push(normMap({ key: makeKey(name), name, mirv, tier }));
    }

    _writeJson(out);
    console.log(`[maps] migrated ${out.length} entries from mappool.txt to mappool.json`);
  } catch (e) {
    console.error("[maps] migration failed:", e);
  }
}

// Public API
function loadMapsFromDisk() {
  migrateFromTxtIfNeeded();
  return _readJson();
}

function getMapList() {
  return loadMapsFromDisk();
}

function addMap(name, mirv, tier) {
  const arr = loadMapsFromDisk();
  const entry = normMap({ key: makeKey(name), name, mirv, tier });
  arr.push(entry);
  _writeJson(arr);
  return arr;
}

function deleteMapByIndex(index1) {
  const arr = loadMapsFromDisk();
  const idx = Math.max(0, Math.min(arr.length - 1, Number(index1) - 1));
  if (!arr.length || idx < 0 || idx >= arr.length) return { list: arr, removed: null };
  const removed = arr.splice(idx, 1)[0] || null;
  _writeJson(arr);
  return { list: arr, removed };
}

function editMap(index1, name, mirv, tier) {
  const arr = loadMapsFromDisk();
  const idx = Math.max(0, Math.min(arr.length - 1, Number(index1) - 1));
  if (!arr.length || idx < 0 || idx >= arr.length) return { list: arr, updated: null };
  const prev = arr[idx];
  arr[idx] = normMap({
    key: prev.key,
    name,
    mirv,
    tier,
    forceTeam1Starts: prev.forceTeam1Starts,
  });
  _writeJson(arr);
  return { list: arr, updated: arr[idx] };
}

// ---- helpers for voteFlow ----
function pickUniqueMaps(allMaps, excludeNames = new Set(), count = 4) {
  const lowerExcl = new Set([...excludeNames].map(x => String(x).toLowerCase()));
  const pool = allMaps.filter(m => m && m.name && !lowerExcl.has(String(m.name).toLowerCase()));
  const out = [];
  while (pool.length && out.length < count) {
    const i = randomInt(0, pool.length);
    out.push(pool[i]);
    pool.splice(i, 1);
  }
  return out;
}

/**
 * pickTieredMapsWithCountsWeighted:
 * Selects 4 maps total using weighted tier probabilities.
 * Example weights: Tier1 = 60%, Tier2 = 30%, Tier3 = 10%.
 */
function pickTieredMapsWithCountsWeighted(allMaps, excludeNames = new Set(), carryOver = null) {
  const pool = allMaps.filter(m => m && m.name && !excludeNames.has(m.name.toLowerCase()));
  const tiers = {
    1: pool.filter(m => m.tier === 1),
    2: pool.filter(m => m.tier === 2),
    3: pool.filter(m => m.tier === 3),
  };

  // 🎯 Adjustable weighted probabilities (must sum ≈ 1.0)
  const weights = {
    1: parseFloat(process.env.TIER1_WEIGHT || 0.545),
    2: parseFloat(process.env.TIER2_WEIGHT || 0.318),
    3: parseFloat(process.env.TIER3_WEIGHT || 0.136),
  };

  const rollTier = () => {
    const r = Math.random();
    if (r < weights[1]) return 1;
    if (r < weights[1] + weights[2]) return 2;
    return 3;
  };

  const out = [];

  // ✅ Keep carried-over map if provided
  let carryMap = null;
  if (carryOver) {
    carryMap = allMaps.find(m => m.name.toLowerCase() === carryOver.toLowerCase());
    if (carryMap) out.push(carryMap);
  }

  // 🎲 Fill remaining slots up to 4 total
  while (out.length < 4) {
    const tier = rollTier();
    const poolArr = tiers[tier];
    if (!poolArr.length) continue;

    const pick = poolArr[Math.floor(Math.random() * poolArr.length)];
    if (out.some(m => m.name.toLowerCase() === pick.name.toLowerCase())) continue;
    out.push(pick);
  }

  // ✅ Guarantee 4 unique maps
  while (out.length > 4) out.pop();

  return out;
}



/**
 * Legacy pickTieredMaps (still used for Round 1)
 */
function pickTieredMaps(allMaps, excludeNames = new Set(), carryOverTier = null) {
  const pool = allMaps.filter(m => m && m.name && !excludeNames.has(m.name.toLowerCase()));
  const tier1 = pool.filter(m => m.tier === 1);
  const tier2 = pool.filter(m => m.tier === 2);
  const tier3 = pool.filter(m => m.tier === 3);

  const pick = (arr, n) => {
    const copy = [...arr];
    const out = [];
    while (copy.length && out.length < n) {
      const i = randomInt(0, copy.length);
      out.push(copy[i]);
      copy.splice(i, 1);
    }
    return out;
  };

  const out = [];
  if (carryOverTier !== 1) out.push(...pick(tier1, 2));
  if (carryOverTier !== 2) out.push(...pick(tier2, 1));
  if (carryOverTier !== 3) out.push(...pick(tier3, 1));

  out.push({ key: "new", name: "New Maps", tier: 99, mirv: 0 });
  return out;
}

function buildMapOptionsFromList(list, includeNewButton = true) {
  const seen = new Set();
  const opts = [];

  for (const m of (list || [])) {
    const key = m?.name?.toLowerCase();
    if (!key || seen.has(key)) continue; // ✅ skip duplicates
    seen.add(key);

    opts.push({
      id: String(opts.length + 1),
      name: m.name,
      tier: m.tier,
      mirv: m.mirv,
      ref: m,
    });
  }

  if (includeNewButton) opts.push({ id: "N", name: "New Maps", ref: null });
  return opts.slice(0, 9);
}

function recentMapExclusions(matchesStore, limit = 7) {
  try {
    const rows = matchesStore.getRecent(limit * 2) || [];
    const out = [];
    const seen = new Set();
    for (const m of rows) {
      const key = String(m.map || m.map_name || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      out.push(key);
      seen.add(key);
      if (out.length >= limit) break;
    }
    return new Set(out);
  } catch (e) {
    console.error("[recentMapExclusions] failed:", e);
    return new Set();
  }
}

module.exports = {
  mirvLabel,
  loadMapsFromDisk,
  getMapList,
  addMap,
  deleteMapByIndex,
  editMap,
  pickUniqueMaps,
  pickTieredMaps,
  pickTieredMapsWithCounts: pickTieredMapsWithCountsWeighted, // ✅ use weighted version
  buildMapOptionsFromList,
  recentMapExclusions,
};
