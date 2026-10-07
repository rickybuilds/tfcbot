import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLogs } from './parse.js';
import { MatchStore, hashLogs, validMatchId } from './store.js';

export async function runCli(args: string[]) {
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const matchId = value('--match-id');
  const output = value('--output');
  const dataDir = value('--data-dir') || process.env.NONAME_PARSER_DATA_DIR || './data';
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (['--match-id', '--output', '--data-dir'].includes(args[i])) { i++; continue; }
    if (!['--force', '--reparse'].includes(args[i])) files.push(resolve(args[i]));
  }
  if (!validMatchId(matchId)) throw new Error('Usage: npm run parse -- --match-id MATCH [--force] [--output result.json] [--data-dir ./data] ROUND1.log [ROUND2.log]; use --reparse to read archived logs.');
  const store = new MatchStore(dataDir);
  const inputs = args.includes('--reparse') ? await store.logPaths(matchId) : files;
  const result = await parseLogs(inputs, { matchId, sourceHash: await hashLogs(inputs), force: args.includes('--force') });
  await store.save(result, inputs);
  if (output) await writeFile(resolve(output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ matchId, map: result.map, rounds: result.rounds.length, sentryPlayers: result.rounds.map(round => round.sentry.length), dataDir: resolve(dataDir) }));
  return result;
}
runCli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
