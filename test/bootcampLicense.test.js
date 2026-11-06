"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeLicense,
  bestLicense,
  parseEndorsements,
  formatLevel,
  formatEndorsement,
  TIER,
} = require("../lib/bootcampLicense");

// Three rotation maps, each with the full drill catalogue and some routes.
const MAPS = ["openfire", "well", "avanti"];
const SLUGS = [
  ["tour_quiz", 0], ["live_target", 0],
  ["sg_placement", 9], ["sg_build_race", 9], ["sg_rebuild", 9], ["sg_live", 9],
  ["pos_get_to", 0], ["pos_coverage", 0], ["pos_flag", 0], ["pos_recovery", 0], ["pos_chase", 0], ["hw_support", 6],
  ["pipe_trap", 4], ["pipe_detonation", 4], ["pipe_reset", 4], ["pipe_flagcalls", 4],
];

function fixture() {
  let id = 1;
  const drills = [];
  const routes = [];
  for (const map of MAPS) {
    for (const [slug, classId] of SLUGS) drills.push({ id: id++, map, slug, class_id: classId });
    routes.push({ id: id++, map, slug: `${map}_conc1`, type: "conc", class_id: 5 });
    routes.push({ id: id++, map, slug: `${map}_conc2`, type: "conc", class_id: 5 });
    routes.push({ id: id++, map, slug: `${map}_flag`, type: "flagrun", class_id: 5 });
  }
  const rotation = MAPS.map((map, i) => ({ map, rotation_order: i }));
  return { drills, routes, rotation };
}

function drillTier(f, map, slug, classId, tier) {
  const d = f.drills.find(x => x.map === map && x.slug === slug);
  return { target_type: "drill", target_id: d.id, class_id: classId, tier };
}

function routeTier(f, map, slug, classId, tier) {
  const r = f.routes.find(x => x.map === map && x.slug === slug);
  return { target_type: "route", target_id: r.id, class_id: classId, tier };
}

function licensedTiers(f) {
  const tiers = [];
  for (const map of MAPS) {
    tiers.push(drillTier(f, map, "tour_quiz", 3, TIER.bronze));
    tiers.push(drillTier(f, map, "live_target", 3, TIER.silver));
    for (const slug of ["sg_placement", "sg_build_race", "sg_rebuild", "sg_live"])
      tiers.push(drillTier(f, map, slug, 9, TIER.silver));
  }
  return tiers;
}

test("no tiers means no license and explains the first step", () => {
  const f = fixture();
  const result = computeLicense({ ...f, tiers: [] });
  assert.equal(result.level, "none");
  assert.deepEqual(result.endorsements, []);
  assert.match(result.progress[0], /permit/);
});

test("a bronze tour quiz on any map earns the learner's permit", () => {
  const f = fixture();
  const result = computeLicense({ ...f, tiers: [drillTier(f, "well", "tour_quiz", 3, TIER.bronze)] });
  assert.equal(result.level, "permit");
});

test("quiz, live-target and one defensive class at silver on every license map earns the license", () => {
  const f = fixture();
  const result = computeLicense({ ...f, tiers: licensedTiers(f) });
  assert.equal(result.level, "licensed");
});

test("a defensive class must be silver in every one of its drills on every license map", () => {
  const f = fixture();
  const tiers = licensedTiers(f).filter(t => !(t.target_id === f.drills.find(d => d.map === "avanti" && d.slug === "sg_rebuild").id));
  tiers.push(drillTier(f, "avanti", "sg_rebuild", 9, TIER.bronze));
  const result = computeLicense({ ...f, tiers });
  assert.equal(result.level, "permit");
  assert.ok(result.progress.some(p => /defensive class/.test(p)));
});

test("defense tiers only count for that class", () => {
  const f = fixture();
  // SG drills done as a soldier do not satisfy the engineer group.
  const tiers = licensedTiers(f).map(t => (t.class_id === 9 ? { ...t, class_id: 3 } : t));
  assert.equal(computeLicense({ ...f, tiers }).level, "permit");
});

test("only the first licenseMaps rotation maps are required for the license", () => {
  const f = fixture();
  const tiers = licensedTiers(f).filter(t => {
    const d = f.drills.find(x => x.id === t.target_id);
    return d.map !== "avanti";
  });
  assert.equal(computeLicense({ ...f, tiers, rules: { licenseMaps: 2 } }).level, "licensed");
  assert.equal(computeLicense({ ...f, tiers }).level, "permit");
});

test("offense endorsement needs two conc/bhop routes and a flag run at silver on every rotation map", () => {
  const f = fixture();
  const tiers = licensedTiers(f);
  for (const map of MAPS) {
    tiers.push(routeTier(f, map, `${map}_conc1`, 5, TIER.silver));
    tiers.push(routeTier(f, map, `${map}_conc2`, 5, TIER.gold));
    tiers.push(routeTier(f, map, `${map}_flag`, 5, TIER.silver));
  }
  const result = computeLicense({ ...f, tiers });
  assert.ok(result.endorsements.includes("offense"));

  const missingFlag = tiers.filter(t => t.target_id !== f.routes.find(r => r.slug === "well_flag").id);
  assert.ok(!computeLicense({ ...f, tiers: missingFlag }).endorsements.includes("offense"));
});

test("endorsements require the license", () => {
  const f = fixture();
  const tiers = [];
  for (const map of MAPS) {
    tiers.push(routeTier(f, map, `${map}_conc1`, 5, TIER.platinum));
    tiers.push(routeTier(f, map, `${map}_conc2`, 5, TIER.platinum));
    tiers.push(routeTier(f, map, `${map}_flag`, 5, TIER.platinum));
  }
  assert.deepEqual(computeLicense({ ...f, tiers }).endorsements, []);
});

test("class badge needs gold in all of the class's routes and drills", () => {
  const f = fixture();
  const tiers = licensedTiers(f).map(t => (t.class_id === 9 ? { ...t, tier: TIER.gold } : t));
  const result = computeLicense({ ...f, tiers });
  assert.ok(result.endorsements.includes("class:engineer"));
  assert.ok(!result.endorsements.includes("class:medic"));
});

test("platinum needs one class's full set at platinum on every rotation map", () => {
  const f = fixture();
  const tiers = licensedTiers(f).map(t => (t.class_id === 9 ? { ...t, tier: TIER.platinum } : t));
  assert.equal(computeLicense({ ...f, tiers }).level, "platinum");

  const short = tiers.filter(t => t.target_id !== f.drills.find(d => d.map === "well" && d.slug === "sg_live").id);
  short.push(drillTier(f, "well", "sg_live", 9, TIER.gold));
  assert.equal(computeLicense({ ...f, tiers: short }).level, "licensed");
});

test("levels and endorsements never go down", () => {
  const f = fixture();
  const result = computeLicense({
    ...f,
    tiers: [],
    previous: { level: "licensed", endorsements: ["offense"] },
  });
  assert.equal(result.level, "licensed");
  assert.deepEqual(result.endorsements, ["offense"]);
});

test("a new rotation map does not revoke a license but is needed for new endorsements", () => {
  const f = fixture();
  const tiers = licensedTiers(f);
  for (const map of MAPS) {
    tiers.push(routeTier(f, map, `${map}_conc1`, 5, TIER.silver));
    tiers.push(routeTier(f, map, `${map}_conc2`, 5, TIER.silver));
    tiers.push(routeTier(f, map, `${map}_flag`, 5, TIER.silver));
  }
  const before = computeLicense({ ...f, tiers });
  assert.ok(before.endorsements.includes("offense"));

  const withNew = fixture();
  withNew.rotation.unshift({ map: "shutdown2", rotation_order: -1 });
  withNew.drills.push({ id: 9000, map: "shutdown2", slug: "tour_quiz", class_id: 0 });
  const after = computeLicense({ ...withNew, tiers, previous: before });
  assert.equal(after.level, "licensed");
  assert.ok(after.endorsements.includes("offense"));
});

test("bestLicense merges linked Steam IDs", () => {
  const merged = bestLicense({ level: "permit", endorsements: ["class:medic"] }, { level: "licensed", endorsements: ["offense"] });
  assert.equal(merged.level, "licensed");
  assert.deepEqual(merged.endorsements, ["class:medic", "offense"]);
});

test("formatting helpers", () => {
  assert.deepEqual(parseEndorsements("offense, class:hwguy,"), ["offense", "class:hwguy"]);
  assert.equal(formatLevel("permit"), "Learner's permit");
  assert.equal(formatEndorsement("class:hwguy"), "HWGuy");
  assert.equal(formatEndorsement("offense"), "Offense");
});
