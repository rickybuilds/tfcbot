import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchStore, validMatchId } from '../src/store.js';

it('rejects traversal and stores private logs plus restart-readable JSON atomically', async () => {
  for (const id of ['../secret', 'a/b', '', '..', 'a'.repeat(81)]) expect(validMatchId(id)).toBe(false);
  const root = await mkdtemp(join(tmpdir(), 'nn-store-'));
  try {
    const input = join(root, 'upload.log');
    await writeFile(input, 'private input');
    const store = new MatchStore(join(root, 'data'));
    const result: any = { matchId: 'MATCH_1', schemaVersion: 1, map: 'siege', parsedAt: '2026-10-07T05:00:00Z', sourceHash: 'abc', rounds: [{ round: 1 }] };
    await store.save(result, [input]);
    const restarted = new MatchStore(join(root, 'data'));
    expect(await restarted.get('MATCH_1')).toEqual(result);
    expect(await restarted.list()).toEqual([{ matchId: 'MATCH_1', map: 'siege', parsedAt: '2026-10-07T05:00:00Z', rounds: 1 }]);
    expect(await restarted.logPaths('MATCH_1')).toHaveLength(1);
    expect(await readdir(join(root, 'data'))).toEqual(['MATCH_1']);
    await expect(store.get('../secret')).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves the previous private raw log archive on authorized replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nn-store-history-'));
  try {
    const input = join(root, 'upload.log'), data = join(root, 'data');
    const store = new MatchStore(data);
    const result: any = { matchId: 'MATCH_1', schemaVersion: 1, map: 'siege', parsedAt: '2026-10-07T05:00:00Z', sourceHash: 'first', rounds: [] };
    await writeFile(input, 'original private log');
    await store.save(result, [input]);
    await writeFile(input, 'replacement private log');
    await store.save({ ...result, sourceHash: 'second' }, [input]);
    const versions = await readdir(join(data, '.history', 'MATCH_1'));
    expect(versions).toHaveLength(1);
    expect(await readFile(join(data, '.history', 'MATCH_1', versions[0], 'round-1.log'), 'utf8')).toBe('original private log');
    expect(await readFile((await store.logPaths('MATCH_1'))[0], 'utf8')).toBe('replacement private log');
    expect((await store.list()).map(row => row.matchId)).toEqual(['MATCH_1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
