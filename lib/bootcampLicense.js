// lib/bootcampLicense.js
"use strict";

// TFC license rules for Noname TFC Bootcamp.
//
// The Bootcamp plugin writes tiers (bootcamp_tiers) for routes and drills;
// this module turns a player's tiers into a license level and endorsements:
//
//   Learner's permit  bronze on the map-tour quiz for one map
//   TFC license       bronze on the tour quiz for the first rotation maps, plus
//                     silver in one defensive class's drills and in the
//                     live-target trainer on those maps
//   Offense           silver on two conc/bhop routes and one flag run per
//                     rotation map
//   Class badge       gold in all of one class's routes and drills on the
//                     rotation maps
//   Platinum license  platinum in one class's full set on every rotation map
//
// Levels and endorsements never go down: a license earned before a map joined
// the rotation stays valid.

const TIER = { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 };
const LEVELS = ["none", "permit", "licensed", "platinum"];

const CLASS_IDS = {
  scout: 1, sniper: 2, soldier: 3, demoman: 4, medic: 5,
  hwguy: 6, pyro: 7, spy: 8, engineer: 9,
};
const CLASS_NAMES = Object.fromEntries(Object.entries(CLASS_IDS).map(([k, v]) => [v, k]));

// Defensive groups: one of these, at the defense tier on every license map.
const DEFENSE_GROUPS = {
  engineer: { classIds: [9], drills: ["sg_placement", "sg_build_race", "sg_rebuild", "sg_live"] },
  soldier: { classIds: [3], drills: ["pos_get_to", "pos_coverage", "pos_flag", "pos_recovery", "pos_chase"] },
  hwguy: { classIds: [6], drills: ["pos_get_to", "pos_coverage", "pos_flag", "pos_recovery", "pos_chase", "hw_support"] },
  demoman: { classIds: [4], drills: ["pipe_trap", "pipe_detonation", "pipe_reset", "pipe_flagcalls"] },
};

const DEFAULT_RULES = Object.freeze({
  licenseMaps: 3,          // first N rotation maps by rotation_order
  permitQuizTier: TIER.bronze,
  licenseQuizTier: TIER.bronze,
  defenseTier: TIER.silver,
  liveTargetTier: TIER.silver,
  offenseRouteTier: TIER.silver,
  offenseMovementRoutes: 2, // conc or bhop routes per map
  offenseFlagRuns: 1,       // flagrun routes per map
  classTier: TIER.gold,
  platinumTier: TIER.platinum,
});

function rulesFrom(overrides) {
  const rules = { ...DEFAULT_RULES };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (key in rules && Number.isFinite(Number(value))) rules[key] = Number(value);
  }
  return rules;
}

/**
 * Indexes tier rows for lookups.
 * tierRows: [{ target_type: "route"|"drill", target_id, class_id, tier }]
 * Returns best(targetType, targetId, classIds?) -> highest tier, optionally
 * only counting rows for the given classes.
 */
function tierIndex(tierRows) {
  const map = new Map();
  for (const row of tierRows || []) {
    const key = `${row.target_type}:${Number(row.target_id)}`;
    const list = map.get(key) || [];
    list.push({ classId: Number(row.class_id) || 0, tier: Number(row.tier) || 0 });
    map.set(key, list);
  }
  return function best(targetType, targetId, classIds) {
    const list = map.get(`${targetType}:${Number(targetId)}`) || [];
    let top = 0;
    for (const entry of list) {
      if (classIds && classIds.length && !classIds.includes(entry.classId)) continue;
      if (entry.tier > top) top = entry.tier;
    }
    return top;
  };
}

function byMap(rows) {
  const out = new Map();
  for (const row of rows || []) {
    const list = out.get(row.map) || [];
    list.push(row);
    out.set(row.map, list);
  }
  return out;
}

function drillBySlug(drillsOnMap, slug) {
  return (drillsOnMap || []).find(d => d.slug === slug) || null;
}

/**
 * Computes a license.
 *
 * input = {
 *   tiers:     bootcamp_tiers rows for one player (or several linked Steam IDs)
 *   drills:    bootcamp_drills rows { id, map, slug, kind, class_id }
 *   routes:    bootcamp_routes rows { id, map, slug, type, class_id }
 *   rotation:  bootcamp_maps rows in the rotation { map, rotation_order }
 *   previous:  { level, endorsements: [] } already granted (never lowered)
 *   rules:     overrides of DEFAULT_RULES
 * }
 *
 * Returns { level, endorsements, progress } where progress explains what is
 * still missing for the next level (for license cards).
 */
function computeLicense(input) {
  const rules = rulesFrom(input.rules);
  const best = tierIndex(input.tiers);
  const drillsByMap = byMap(input.drills);
  const routesByMap = byMap(input.routes);
  const rotation = [...(input.rotation || [])]
    .sort((a, b) => (Number(a.rotation_order) || 0) - (Number(b.rotation_order) || 0) || String(a.map).localeCompare(String(b.map)));
  const rotationMaps = rotation.map(r => r.map);
  const licenseMaps = rotationMaps.slice(0, Math.max(1, rules.licenseMaps));
  const progress = [];

  const quizTier = map => {
    const quiz = drillBySlug(drillsByMap.get(map), "tour_quiz");
    return quiz ? best("drill", quiz.id) : 0;
  };

  // Permit: any map's tour quiz at bronze.
  const allMaps = [...new Set((input.drills || []).map(d => d.map))];
  const permit = allMaps.some(map => quizTier(map) >= rules.permitQuizTier);
  if (!permit) progress.push("Bronze on a map-tour quiz earns the learner's permit.");

  // License
  let licensed = false;
  if (licenseMaps.length) {
    const quizOk = licenseMaps.every(map => quizTier(map) >= rules.licenseQuizTier);
    if (!quizOk) {
      const missing = licenseMaps.filter(map => quizTier(map) < rules.licenseQuizTier);
      progress.push(`Map-tour quiz (bronze) still needed on: ${missing.join(", ")}.`);
    }

    const liveOk = licenseMaps.every(map => {
      const live = drillBySlug(drillsByMap.get(map), "live_target");
      return live && best("drill", live.id) >= rules.liveTargetTier;
    });
    if (!liveOk) progress.push("Silver in the live-target trainer on each license map.");

    const defenseGroup = Object.entries(DEFENSE_GROUPS).find(([, group]) =>
      licenseMaps.every(map => {
        const drills = drillsByMap.get(map) || [];
        const present = group.drills.map(slug => drillBySlug(drills, slug)).filter(Boolean);
        return present.length > 0 && present.every(d => best("drill", d.id, group.classIds) >= rules.defenseTier);
      })
    );
    if (!defenseGroup) progress.push("Silver in every drill of one defensive class (engineer, soldier, HWGuy or demoman) on each license map.");

    licensed = permit && quizOk && liveOk && Boolean(defenseGroup);
  } else {
    progress.push("No maps are in the license rotation yet.");
  }

  // Endorsements (need the license)
  const endorsements = new Set(input.previous?.endorsements || []);
  if (licensed && rotationMaps.length) {
    const offenseOk = rotationMaps.every(map => {
      const routes = routesByMap.get(map) || [];
      const movement = routes.filter(r => (r.type === "conc" || r.type === "bhop") && best("route", r.id) >= rules.offenseRouteTier);
      const flagRuns = routes.filter(r => r.type === "flagrun" && best("route", r.id) >= rules.offenseRouteTier);
      return movement.length >= rules.offenseMovementRoutes && flagRuns.length >= rules.offenseFlagRuns;
    });
    if (offenseOk) endorsements.add("offense");
    else if (!endorsements.has("offense")) progress.push("Offense: silver on two conc/bhop routes and one flag run per rotation map.");

    for (const [name, classId] of Object.entries(CLASS_IDS)) {
      const items = classItems(classId, rotationMaps, drillsByMap, routesByMap);
      if (items.length && items.every(item => best(item.type, item.id, [classId]) >= rules.classTier))
        endorsements.add(`class:${name}`);
    }
  }

  // Platinum: one class's full set at platinum on every rotation map.
  let platinum = false;
  if (licensed && rotationMaps.length) {
    platinum = Object.values(CLASS_IDS).some(classId => {
      return rotationMaps.every(map => {
        const items = classItems(classId, [map], drillsByMap, routesByMap);
        return items.length > 0 && items.every(item => best(item.type, item.id, [classId]) >= rules.platinumTier);
      });
    });
  }

  let level = platinum ? "platinum" : licensed ? "licensed" : permit ? "permit" : "none";
  const previousLevel = input.previous?.level || "none";
  if (LEVELS.indexOf(previousLevel) > LEVELS.indexOf(level)) level = previousLevel;

  return { level, endorsements: [...endorsements].sort(), progress };
}

// A class's items: its drills (by class or defensive group) and its routes.
function classItems(classId, maps, drillsByMap, routesByMap) {
  const items = [];
  const groupDrills = new Set();
  for (const group of Object.values(DEFENSE_GROUPS))
    if (group.classIds.includes(classId)) group.drills.forEach(slug => groupDrills.add(slug));

  for (const map of maps) {
    for (const d of drillsByMap.get(map) || []) {
      if (Number(d.class_id) === classId || groupDrills.has(d.slug))
        items.push({ type: "drill", id: d.id });
    }
    for (const r of routesByMap.get(map) || []) {
      if (Number(r.class_id) === classId)
        items.push({ type: "route", id: r.id });
    }
  }
  return items;
}

function levelRank(level) {
  return Math.max(0, LEVELS.indexOf(level));
}

// The better of two licenses (a Discord member may link several Steam IDs).
function bestLicense(a, b) {
  if (!a) return b;
  if (!b) return a;
  const level = levelRank(a.level) >= levelRank(b.level) ? a.level : b.level;
  const endorsements = [...new Set([...(a.endorsements || []), ...(b.endorsements || [])])].sort();
  return { level, endorsements };
}

function parseEndorsements(text) {
  return String(text || "").split(",").map(s => s.trim()).filter(Boolean);
}

function formatLevel(level) {
  return {
    none: "No license",
    permit: "Learner's permit",
    licensed: "TFC license",
    platinum: "Platinum license",
  }[level] || "No license";
}

function formatEndorsement(e) {
  if (e === "offense") return "Offense";
  if (e.startsWith("class:")) {
    const name = e.slice(6);
    return name === "hwguy" ? "HWGuy" : name.charAt(0).toUpperCase() + name.slice(1);
  }
  return e;
}

module.exports = {
  TIER,
  LEVELS,
  CLASS_IDS,
  CLASS_NAMES,
  DEFENSE_GROUPS,
  DEFAULT_RULES,
  computeLicense,
  bestLicense,
  levelRank,
  parseEndorsements,
  formatLevel,
  formatEndorsement,
};
