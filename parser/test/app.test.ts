import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { MatchStore } from '../src/store.js';

describe('authenticated parsing API', () => {
  let root: string, base: string, server: Server;
  async function form(id: string, filename = 'L0308008.log') {
    const body = new FormData();
    body.set('matchId', id);
    body.append('logs[]', new Blob([await readFile(resolve('upstream/test', filename))]), filename);
    return body;
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nn-api-'));
    server = createApp({ store: new MatchStore(join(root, 'data')), token: 'test-secret', uploadDir: join(root, 'uploads') }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  it('blocks unauthorized writes and unsafe match IDs', async () => {
    expect((await fetch(`${base}/api/matches`)).status).toBe(401);
    const unauthorized = await fetch(`${base}/api/parseGame`, { method: 'POST', body: await form('TEST') });
    expect(unauthorized.status).toBe(401);
    const unsafe = await fetch(`${base}/api/parseGame`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: await form('../secret') });
    expect(unsafe.status).toBe(400);
  });
  it('parses and archives a single round, returns JSON without scraping and serves a match page', async () => {
    const response = await fetch(`${base}/api/parseGame`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: await form('TEST') });
    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.result.rounds).toHaveLength(1);
    expect(body.success.path).toBe('https://nonamepickup.servehalflife.com/match.html?id=TEST');
    expect(body.success.api).toBe(`${base}/api/matches/TEST`);
    const result = await fetch(body.success.api, { headers: { authorization: 'Bearer test-secret' } }).then(res => res.json()) as any;
    expect(result.matchId).toBe('TEST');
    expect(result.sourceHash).toHaveLength(64);
    const repeated = await fetch(`${base}/api/parseGame`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: await form('TEST') });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as any).result.parsedAt).toBe(result.parsedAt);
    expect((await fetch(`${base}/matches/TEST`)).status).toBe(404);
    expect((await fetch(`${base}/api/matches`, { headers: { authorization: 'Bearer test-secret' } }).then(res => res.json()) as any).matches[0].matchId).toBe('TEST');
  });
  it('refuses conflicting logs unless replacement is explicit and keeps logs private', async () => {
    const response = await fetch(`${base}/api/parseGame`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: await form('TEST', 'L0522000.log') });
    expect(response.status).toBe(409);
    expect((await fetch(`${base}/data/TEST/round-1.log`)).status).toBe(404);
    const missing = await fetch(`${base}/api/matches/NOT_FOUND`, { headers: { authorization: 'Bearer test-secret' } });
    expect(missing.status).toBe(404);
  });
  it('rejects non-log input and does not leak parser errors', async () => {
    const body = new FormData(); body.set('matchId', 'INVALID'); body.append('logs[]', new Blob(['rcon_password super-secret']), 'bad.txt');
    const response = await fetch(`${base}/api/parseGame`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('super-secret');
  });
});
