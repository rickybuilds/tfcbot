"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { parseAndImport } = require('../tools/parseNoNameLogs');

test('local logs parse directly into the database and archived logs can be reimported without duplicates', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-direct-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const files = ['L0308008.log', 'L0308009.log'].map(name => path.resolve(__dirname, '../parser/upstream/test', name));
  const first = await parseAndImport({ matchId: 'DIRECT', files, dataDir, db, force: true });
  assert.equal(first.players, 8);
  assert.equal(first.rounds, 2);
  const saved = db.prepare('SELECT result_json FROM match_parser_results WHERE match_id=?').get('DIRECT');
  assert.equal(JSON.parse(saved.result_json).hampalyzer.stats.length, 2);
  const count = db.prepare('SELECT COUNT(*) n FROM match_kill_events').get().n;
  assert.ok(count > 100);
  await parseAndImport({ matchId: 'DIRECT', files: [], dataDir, db, reparse: true, force: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM match_kill_events').get().n, count);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM match_sentry_lives').get().n > 0);
});
