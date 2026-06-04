// (deprecated: unified to elo.db) // scripts/migrate_add_match_cols.js
// Usage: node scripts/migrate_add_match_cols.js ./matches.db
"use strict";

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all();
  return rows.some(r => r.name === col);
}

function addCol(db, table, spec) {
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${spec};`).run();
  console.log(`Added column on ${table}: ${spec}`);
}

(function main() {
  const dbPath = process.argv[2] || path.resolve(process.cwd(), "matches.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = wal");

  if (!hasColumn(db, "matches", "hampalyzer_url")) {
    addCol(db, "matches", "hampalyzer_url TEXT");
  }

  if (!hasColumn(db, "matches", "hlds_log_files")) {
    addCol(db, "matches", "hlds_log_files TEXT");
  }

  if (!hasColumn(db, "matches", "mode")) {
    addCol(db, "matches", "mode TEXT DEFAULT 'STANDARD' CHECK (mode IN ('STANDARD','ADL'))");
  }

  console.log("✅ Migration complete.");
})();
