// scripts/purgetestplayers.js
// Purge players whose display_name OR player_id match a case-insensitive pattern
// (default "*test*") from the Elo database, along with their related rows.
// 
// Usage (run from your project root unless you pass --db):
//   node scripts/purgetestplayers.js                                # dry-run for *test*
//   node scripts/purgetestplayers.js --apply                        # apply for *test*
//   node scripts/purgetestplayers.js --pattern="smurf*"             # dry-run custom
//   node scripts/purgetestplayers.js --apply --pattern="smurf*"     # apply custom
//   node scripts/purgetestplayers.js --apply --pattern="smurf*" --vacuum
//   node scripts/purgetestplayers.js --db="C:\path\to\elo.db" --apply
//
// Flags:
//   --db=<path>        Choose DB file (default: ./elo.db)
//   --pattern=<glob>   Match against display_name OR player_id (default: "test*")
//   --apply            Actually delete (otherwise dry-run)
//   --vacuum           Run VACUUM after deletion (compacts file)
//
// Wildcards supported: * → %, ? → _ (SQL LIKE). If you provide no wildcard, it becomes a substring match.
//
// Safety rails:
//   • Requires at least 3 non-wildcard characters in the pattern
//   • Refuses wildcard-only patterns (e.g., "*" or "%%")
//
// Node v18+ recommended.

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
const DB_PATH = arg("--db", path.resolve(process.cwd(), "elo.db"));
const RAW     = String(arg("--pattern", "test*")).trim();

if (!fs.existsSync(DB_PATH)) {
  console.error("DB not found at:", DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function hasTable(name) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(String(name));
    return !!row;
  } catch { return false; }
}

function listTables() {
  try {
    return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
  } catch { return []; }
}

if (!hasTable("ratings")) {
  console.error("❌ This database has no 'ratings' table. You likely opened the wrong DB.");
  const tables = listTables();
  console.error("Tables in this DB:", tables.length ? tables.join(", ") : "(none)");
  process.exit(1);
}

// Convert user glob to SQL LIKE (case-insensitive).
//   • Strips raw %/_ the user might pass
//   • Translates * → %, ? → _
//   • If no wildcard present, wraps with % for substring match.
function toSqlLike(glob) {
  const onlyWild = /^[\*\%_]+$/.test(glob);
  if (onlyWild) return null;
  let like = glob
    .replace(/[%_]/g, "") // remove raw SQL wildcards
    .replace(/\*/g, "%")
    .replace(/\?/g, "_")
    .trim();
  if (!like.includes("%") && !like.includes("_")) like = `%${like}%`;
  return like.toLowerCase();
}

// Require 3+ non-wildcard characters
const CORE = RAW.replace(/[\*\?_]/g, "");
if (CORE.length < 3) {
  console.error("Refusing to run: pattern too short. Provide at least 3 letters (e.g., test).");
  process.exit(1);
}

const LIKE = toSqlLike(RAW);
if (!LIKE) {
  console.error("Refusing to run with an empty/wildcard-only pattern.");
  process.exit(1);
}

// Fetch candidates
const candidates = db.prepare(`
  SELECT player_id, COALESCE(display_name,'') AS display_name, rating
  FROM ratings
  WHERE LOWER(display_name) LIKE ?
     OR LOWER(player_id)    LIKE ?
`).all(LIKE, LIKE);

if (!candidates.length) {
  console.log(`[OK] No players match pattern "${RAW}". DB: ${DB_PATH}`);
  process.exit(0);
}

const ids = candidates.map(r => String(r.player_id));
const placeholders = ids.map(() => "?").join(",");

// Count related rows
function countOf(table) {
  try {
    if (!hasTable(table)) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id IN (${placeholders})`).get(...ids);
    return row?.n || 0;
  } catch { return 0; }
}

const counts = {
  rating_changes: countOf("rating_changes"),
  permap_changes: countOf("permap_changes"),
  permap_ratings: countOf("permap_ratings"),
};

// Preview
console.log("=== Purge Test Players — Preview ===");
console.log("DB:", DB_PATH);
console.log("Pattern:", RAW, "→ SQL LIKE:", LIKE);
console.log("Players matched:", candidates.length);
Object.entries(counts).forEach(([k,v]) => {
  if (hasTable(k)) console.log(`${k}:`, v);
});

const sample = candidates.slice(0, 12).map(r => `  • ${r.player_id} (${r.display_name || "?"}) rating=${r.rating}`).join("\n");
if (sample) {
  console.log("Sample:\n" + sample);
}

if (!APPLY) {
  console.log("\n[DRY RUN] To apply:\n  node scripts/purgetestplayers.js --apply --pattern=\"%s\"".replace("%s", RAW));
  console.log("Add --vacuum to compact afterward.");
  process.exit(0);
}

// Apply
const tx = db.transaction(() => {
  if (counts.rating_changes && hasTable("rating_changes")) {
    db.prepare(`DELETE FROM rating_changes WHERE player_id IN (${placeholders})`).run(...ids);
  }
  if (counts.permap_changes && hasTable("permap_changes")) {
    db.prepare(`DELETE FROM permap_changes WHERE player_id IN (${placeholders})`).run(...ids);
  }
  if (counts.permap_ratings && hasTable("permap_ratings")) {
    db.prepare(`DELETE FROM permap_ratings WHERE player_id IN (${placeholders})`).run(...ids);
  }
  db.prepare(`DELETE FROM ratings WHERE player_id IN (${placeholders})`).run(...ids);
});
tx();

console.log(`\n[DONE] Deleted ${candidates.length} player(s) and related rows.`);

// Optional VACUUM
if (VACUUM) {
  try {
    db.exec("VACUUM;");
    console.log("[VACUUM] Completed.");
  } catch (e) {
    console.log("[VACUUM] Failed (ignored):", e?.message || e);
  }
}

db.close();
