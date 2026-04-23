// lib/settings.js
const Database = require("better-sqlite3");
const path = require("path");

class SettingsDB {
  constructor(dbFile = "bot.db") {
    const full = path.resolve(process.cwd(), dbFile);
    this.db = new Database(full);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.getStmt = this.db.prepare(`SELECT value FROM app_settings WHERE key=?`);
    this.setStmt = this.db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);
  }

  /* -------- Boolean -------- */
  getBool(key, fallback = false) {
    const r = this.getStmt.get(key);
    if (!r) return fallback;
    return r.value === "1" || r.value.toLowerCase() === "true";
  }
  setBool(key, val) {
    this.setStmt.run(key, val ? "1" : "0");
  }

  /* -------- Number -------- */
  getNumber(key, fallback = 0) {
    const r = this.getStmt.get(key);
    if (!r) return fallback;
    const n = Number(r.value);
    return Number.isFinite(n) ? n : fallback;
  }
  setNumber(key, val) {
    this.setStmt.run(key, String(val));
  }

  /* -------- String -------- */
  getString(key, fallback = "") {
    const r = this.getStmt.get(key);
    return r ? String(r.value) : fallback;
  }
  setString(key, val) {
    this.setStmt.run(key, String(val));
  }
}

module.exports = { SettingsDB };
