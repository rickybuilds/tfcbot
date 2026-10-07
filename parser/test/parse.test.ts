import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseLogs } from '../src/parse.js';

const log = (name: string) => resolve('upstream/test', name);
describe('No Name parsing from real fixture logs', () => {
  it('produces two rounds, stable identities, normal stats and sentry lifetimes without raw log secrets', async () => {
    const result = await parseLogs([log('L0308008.log'), log('L0308009.log')], { matchId: 'FIXTURE', force: true });
    expect(result.schemaVersion).toBe(1);
    expect(result.rounds).toHaveLength(2);
    expect(result.map).toBe('schtop');
    expect(result.rounds[0].durationSeconds).toBeGreaterThan(600);
    expect(Object.values(result.rounds[0].teams).flatMap(t => t.players).length).toBeGreaterThan(0);
    expect(Object.values(result.rounds[0].teams).flatMap(t => t.players).every(p => /^STEAM_\d:[01]:\d+$/.test(p.steamID))).toBe(true);
    expect(result.events.filter(e => e.playerFrom).every(e => e.playerFrom!.steamId.startsWith('STEAM_'))).toBe(true);
    expect(result.events.some(e => e.type === 'PlayerFraggedPlayer')).toBe(true);
    expect(result.rounds.flatMap(r => r.sentry).some(s => s.builds > 0)).toBe(true);
    expect(result.hampalyzer.stats).toHaveLength(2);
    expect(result.hampalyzer.stats[0]?.scoring_activity?.flag_movements).toBeDefined();
    expect(result.hampalyzer.comparison).toBeDefined();
    const json = JSON.stringify(result);
    expect(json).not.toContain('rawLine');
    expect(json).not.toContain('ServerCvar');
    expect(json).not.toContain('RconCommand');
    expect(json).not.toContain('playerFromWasCarryingFlag":null');
  });
  it('supports a single round without duplicating it', async () => {
    const result = await parseLogs([log('L0308008.log')], { matchId: 'DUEL' });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].round).toBe(1);
  });
  it('rejects empty and mismatched inputs', async () => {
    await expect(parseLogs([], { matchId: 'BAD' })).rejects.toThrow();
    await expect(parseLogs([log('L0308008.log'), log('L0522000.log')], { matchId: 'BAD' })).rejects.toThrow();
  });
});
