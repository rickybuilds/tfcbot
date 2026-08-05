"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const Database = require("better-sqlite3");
const { scheduleBackups } = require("../lib/backup");

test("backs up committed SQLite data that is still in the WAL", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfcbot-backup-"));

  const source = path.join(dir, "elo.db");
  const destination = path.join(dir, "backups");
  const db = new Database(source);
  let snapshot;
  t.after(() => {
    try { snapshot?.close(); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE ratings (player_id TEXT PRIMARY KEY, rating INTEGER NOT NULL)");
  db.prepare("INSERT INTO ratings (player_id, rating) VALUES (?, ?)").run("player-1", 1941);

  assert.equal(fs.existsSync(`${source}-wal`), true);

  const backups = scheduleBackups(
    { getBool: () => false },
    { sources: [source], destDir: destination }
  );
  const results = await backups.runNow();

  assert.deepEqual(results, [{ file: source, ok: true }]);

  const files = fs.readdirSync(destination);
  assert.equal(files.length, 1);
  assert.match(files[0], /__elo\.db\.gz$/);

  const compressed = fs.readFileSync(path.join(destination, files[0]));
  assert.deepEqual([...compressed.subarray(0, 2)], [0x1f, 0x8b]);
  const restored = path.join(dir, "restored.db");
  fs.writeFileSync(restored, zlib.gunzipSync(compressed));

  snapshot = new Database(restored, { readonly: true });
  assert.deepEqual(
    snapshot.prepare("SELECT player_id, rating FROM ratings").get(),
    { player_id: "player-1", rating: 1941 }
  );
});

test("continues to copy non-database backup sources", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfcbot-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const source = path.join(dir, "queue.json");
  const destination = path.join(dir, "backups");
  fs.writeFileSync(source, '[{"id":"123"}]');

  const backups = scheduleBackups(
    { getBool: () => false },
    { sources: [source], destDir: destination }
  );
  const results = await backups.runNow();

  assert.deepEqual(results, [{ file: source, ok: true }]);
  const files = fs.readdirSync(destination);
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(destination, files[0]), "utf8"), '[{"id":"123"}]');
});
