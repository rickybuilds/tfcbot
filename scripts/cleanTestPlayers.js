// scripts/cleanTestPlayers.js
// Usage:
//   node scripts/cleanTestPlayers.js                  # dry-run, uses ./elo.db
//   node scripts/cleanTestPlayers.js --db=path\elo.db # choose DB file
//   node scripts/cleanTestPlayers.js --apply --pattern="test%" [--vacuum]

"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function arg(flag, def = null) {
  const hit = process.argv.find(a => a.startsWith(flag));
  if (!hit) return def;
  const [k, v] = hit.split("=");
  return v === undefined ? true : v;
}

const APPLY   = !!arg("--apply", false);
const VACUUM  = !!arg("--vacuum", false);
const PATTERN = String(arg("--pattern", "test%")).toLowerCase();
const DB_PATH = arg("--db", path.resolve(process.cwd(), "elo.db"));

if (!fs.existsSync(DB_PATH)) {
  console.error("DB file not found at", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function hasTable(name) {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(String(name));
    return !!row;
  } catch {
    return false;
  }
}

function listTables() {
  try {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all();
    return rows.map(r => r.name);
  } catch { return []; }
}

// Ensure ratings table exists
if (!hasTable("ratings")) {
  console.error("❌ This database has no 'ratings' table. You likely opened the wrong DB.");
  const tables = listTables();
  console.error("Tables in this DB:", tables.length ? tables.join(", ") : "(none)");
  console.error("Tip: use --db=path\\to\\elo.db to point at the Elo database.");
  process.exit(1);
}

// Find candidate players (case-insensitive on display_name or player_id)
const bad = db.prepare(`
  SELECT player_id, COALESCE(display_name,'') AS display_name, rating
  FROM ratings
  WHERE LOWER(display_name) LIKE ?
     OR LOWER(player_id)    LIKE ?
`).all(PATTERN, PATTERN);

if (!bad.length) {
  console.log(`[OK] No players match pattern "${PATTERN}". Nothing to do.`);
  process.exit(0);
}

const ids = bad.map(r => String(r.player_id));
const placeholders = ids.map(() => "?").join(",");

// Counts
let changesCount = 0, permapChanges = 0, permapRatings = 0;
try {
  if (hasTable("rating_changes")) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM rating_changes WHERE player_id IN (${placeholders})`
    ).get(...ids);
    changesCount = row?.n || 0;
  }
} catch {}

if (hasTable("permap_changes")) {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM permap_changes WHERE player_id IN (${placeholders})`
    ).get(...ids);
    permapChanges = row?.n || 0;
  } catch {}
}
if (hasTable("permap_ratings")) {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM permap_ratings WHERE player_id IN (${placeholders})`
    ).get(...ids);
    permapRatings = row?.n || 0;
  } catch {}
}

console.log("=== Preview ===");
console.log(`DB:              ${DB_PATH}`);
console.log(`Pattern:         ${PATTERN}`);
console.log(`Players matched: ${bad.length}`);
if (hasTable("rating_changes")) console.log(`rating_changes:  ${changesCount}`);
if (hasTable("permap_changes")) console.log(`permap_changes:  ${permapChanges}`);
if (hasTable("permap_ratings")) console.log(`permap_ratings:  ${permapRatings}`);
console.log("Sample:");
for (const r of bad.slice(0, 10)) {
  console.log(`  - ${r.player_id} (${r.display_name || "?"}) rating=${r.rating}`);
}

if (!APPLY) {
  console.log("\n[DRY RUN] Use --apply to perform deletion, e.g.:");
  console.log(`node scripts/cleanTestPlayers.js --db="${DB_PATH}" --apply --pattern="${PATTERN}"`);
  process.exit(0);
}

// Apply deletions in a transaction
const tx = db.transaction(() => {
  if (changesCount && hasTable("rating_changes")) {
    db.prepare(`DELETE FROM rating_changes WHERE player_id IN (${placeholders})`).run(...ids);
  }
  if (permapChanges && hasTable("permap_changes")) {
    db.prepare(`DELETE FROM permap_changes WHERE player_id IN (${placeholders})`).run(...ids);
  }
  if (permapRatings && hasTable("permap_ratings")) {
    db.prepare(`DELETE FROM permap_ratings WHERE player_id IN (${placeholders})`).run(...ids);
  }
  db.prepare(`DELETE FROM ratings WHERE player_id IN (${placeholders})`).run(...ids);
});
tx();

console.log(`[DONE] Deleted ${bad.length} player(s) and related rows.`);
if (VACUUM) {
  try { db.exec("VACUUM;"); console.log("[VACUUM] Completed."); }
  catch { console.log("[VACUUM] Failed (ignored)."); }
}
db.close();
