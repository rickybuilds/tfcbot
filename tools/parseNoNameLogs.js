"use strict";
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { importNoNameStats } = require('../lib/noNameStatsImport');
const { matchPageUrl } = require('../services/noNameParser');
const run = promisify(execFile);

async function parseAndImport({ matchId, files = [], dataDir = process.env.NONAME_PARSER_DATA_DIR, db, dbPath = process.env.DB_PATH || '/root/tfcbot/elo.db', force = false, reparse = false }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(matchId || ''))) throw new Error('A valid --match-id is required.');
  if (!reparse && (files.length < 1 || files.length > 2)) throw new Error('Provide one or two round logs.');
  if (!db && !fs.existsSync(dbPath)) throw new Error('The target database must already exist. Set --db or DB_PATH.');
  const parserRoot = path.resolve(__dirname, '../parser');
  const entry = path.join(parserRoot, 'dist/src/cli.js');
  if (!fs.existsSync(entry)) throw new Error('Build the local parser first: npm run parser:setup');
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'noname-import-'));
  try {
    const output = path.join(scratch, 'result.json');
    const args = [entry, '--match-id', matchId, '--output', output, '--data-dir', path.resolve(dataDir || path.join(parserRoot, 'data'))];
    if (force) args.push('--force');
    if (reparse) args.push('--reparse');
    else args.push(...files.map(file => path.resolve(file)));
    await run(process.execPath, args, { cwd: parserRoot, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const result = JSON.parse(await fsp.readFile(output, 'utf8'));
    return importNoNameStats({ result, matchId, sourceUrl: matchPageUrl(matchId), db, dbPath });
  } finally {
    await fsp.unlink(path.join(scratch, 'result.json')).catch(() => {});
    await fsp.rmdir(scratch).catch(() => {});
  }
}
async function main(args) {
  const options = { files: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--match-id': options.matchId = args[++i]; break;
      case '--db': options.dbPath = args[++i]; break;
      case '--data-dir': options.dataDir = args[++i]; break;
      case '--force': options.force = true; break;
      case '--reparse': options.reparse = true; break;
      default:
        if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
        options.files.push(args[i]);
    }
  }
  console.log(JSON.stringify(await parseAndImport(options)));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseAndImport };
