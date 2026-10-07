import { mkdir, readFile, writeFile, readdir, rename, copyFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { MatchResult } from './parse.js';

export const validMatchId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
export class MatchStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private directory(id: string) {
    if (!validMatchId(id)) throw new Error('Invalid match ID.');
    return join(this.root, id);
  }
  async get(id: string): Promise<MatchResult | null> {
    try { return JSON.parse(await readFile(join(this.directory(id), 'result.json'), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list(limit = 50) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const results = await Promise.all(entries.filter(entry => entry.isDirectory() && validMatchId(entry.name)).map(entry => this.get(entry.name)));
    return results.filter((r): r is MatchResult => !!r).sort((a, b) => b.parsedAt.localeCompare(a.parsedAt))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map(r => ({ matchId: r.matchId, map: r.map, parsedAt: r.parsedAt, rounds: r.rounds.length }));
  }
  async logPaths(id: string): Promise<string[]> {
    const directory = this.directory(id);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { logs: string[] };
    if (!manifest.logs.every(name => /^round-[12]\.log$/.test(name))) throw new Error('Invalid archive manifest.');
    return manifest.logs.map(name => join(directory, name));
  }
  async save(result: MatchResult, files: string[]) {
    const directory = this.directory(result.matchId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stage = join(this.root, `.staging-${randomUUID()}`);
    const backup = join(this.root, `.previous-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    let movedOld = false;
    try {
      const logs = files.map((_, i) => `round-${i + 1}.log`);
      await Promise.all(files.map((file, i) => copyFile(file, join(stage, logs[i]))));
      await writeFile(join(stage, 'manifest.json'), JSON.stringify({ logs }), { mode: 0o600 });
      await writeFile(join(stage, 'result.json'), JSON.stringify(result), { mode: 0o600 });
      try { await access(directory); await rename(directory, backup); movedOld = true; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(stage, directory); }
      catch (error) { if (movedOld) await rename(backup, directory); throw error; }
      if (movedOld) await rm(backup, { recursive: true, force: true });
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
export async function hashLogs(files: string[]) {
  const hash = createHash('sha256');
  for (const file of files) {
    const contents = await readFile(file);
    hash.update(String(contents.length)).update(':').update(contents);
  }
  return hash.digest('hex');
}
