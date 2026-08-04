// lib/backup.js
"use strict";
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/* ------------ utils ------------ */
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function backupFilename(src, dstDir) {
  const base = path.basename(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dstDir, `${stamp}__${base}`);
}

function copyFile(src, dstDir) {
  try {
    if (!fs.existsSync(src)) return false;
    ensureDir(dstDir);
    const out = backupFilename(src, dstDir);
    fs.copyFileSync(src, out);
    return true;
  } catch { return false; }
}

function isSQLiteFile(file) {
  return /\.(?:db|sqlite|sqlite3)$/i.test(String(file));
}

async function backupSQLite(src, dstDir) {
  if (!fs.existsSync(src)) return false;

  ensureDir(dstDir);
  const out = backupFilename(src, dstDir);
  let db;

  try {
    // SQLite's online backup API produces a consistent snapshot and includes
    // committed changes that are still in the source database's WAL file.
    db = new Database(path.resolve(src), { readonly: true, fileMustExist: true });
    await db.backup(out);
    return true;
  } catch {
    // Never leave a partial database looking like a successful backup.
    try { fs.rmSync(out, { force: true }); } catch {}
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

async function backupSource(src, dstDir) {
  return isSQLiteFile(src)
    ? backupSQLite(src, dstDir)
    : copyFile(src, dstDir);
}

function parseHHMM(s) {
  const m = String(s || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return { h: 4, min: 0 };
  return {
    h: Math.min(23, Math.max(0, parseInt(m[1], 10))),
    min: Math.min(59, Math.max(0, parseInt(m[2], 10))),
  };
}

function msUntil(h, m) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

/* ------------ settings compat ------------ */
function getBool(settings, key, fb) {
  try {
    if (typeof settings?.getBool === "function") return !!settings.getBool(key, fb);
    const raw = settings?.get?.(key);
    if (raw == null) return !!fb;
    const s = String(raw).toLowerCase();
    return raw === true || raw === 1 || s === "1" || s === "on" || s === "true" || s === "yes";
  } catch { return !!fb; }
}
function getString(settings, key, fb) {
  try {
    if (typeof settings?.getString === "function") return settings.getString(key, fb);
    const raw = settings?.get?.(key);
    return raw != null ? String(raw) : String(fb);
  } catch { return String(fb); }
}

/* ------------ scheduler ------------ */
function scheduleBackups(settings, options = {}) {
  const {
    sources = ["elo.db", "queue.json"],
    destDir = "backups",
  } = options;

  const doBackup = async () => {
    const dest = path.resolve(destDir);
    ensureDir(dest);
    const results = [];
    for (const s of sources) {
      results.push({ file: s, ok: await backupSource(s, dest) });
    }
    return results;
  };

  const runScheduledBackup = () => {
    void doBackup()
      .then(results => {
        const failed = results.filter(result => !result.ok);
        if (failed.length) {
          console.error("[backup] failed:", failed.map(result => result.file).join(", "));
        }
      })
      .catch(err => console.error("[backup] failed:", err));
  };

  const start = () => {
    const enabled = getBool(settings, "backup:enabled", true);
    if (!enabled) return; // don’t schedule timers if disabled

    const t = getString(settings, "backup:time", "04:00");
    const { h, min } = parseHHMM(t);
    const firstIn = msUntil(h, min);

    setTimeout(() => {
      runScheduledBackup();
      setInterval(runScheduledBackup, 24 * 60 * 60 * 1000); // daily
    }, firstIn);
  };

  start();
  return { runNow: doBackup };
}

module.exports = { scheduleBackups };
