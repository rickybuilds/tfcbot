import { describe, expect, it } from 'vitest';
import { Event, type EventCreationOptions } from '../upstream/src/models/event.js';
import EventType from '../upstream/src/models/event-types.js';
import Player from '../upstream/src/models/player.js';
import { PlayerClass, TeamColor, Weapon, type PlayerOutputStatsRound } from '../upstream/src/models/types.js';
import { trackSentries } from '../src/sentry.js';

const eng = new Player('STEAM_0:1:1', 'Engineer', 1, TeamColor.Blue);
const mate = new Player('STEAM_0:1:2', 'Teammate', 2, TeamColor.Blue);
const enemy = new Player('STEAM_0:1:3', 'Enemy', 3, TeamColor.Red);
function event(type: EventType, time: number, options: Partial<EventCreationOptions> = {}): Event {
    const ev = new Event({ eventType: type, rawLine: '', lineNumber: time * 10,
        timestamp: new Date(0), playerFrom: eng, ...options });
    ev.gameTimeAsSeconds = time;
    return ev;
}
function role(time: number, playerClass = PlayerClass.Engineer, player = eng): Event {
    return event(EventType.PlayerChangeRole, time, { playerFrom: player, data: { class: playerClass } });
}
function output(player = eng, engineerSeconds = 100): PlayerOutputStatsRound {
    return { ...player.dumpOutput(player.team), round_number: 1, roles: 'Engineer',
        classes: [{ class: PlayerClass.Engineer, classAsString: 'engineer', timeInSeconds: engineerSeconds }],
        kills: {}, deaths: {} };
}

describe('trackSentries', () => {
    it('counts hand-calculated level lifetimes and player kills without ending on owner death', () => {
        const stats = trackSentries([
            role(-10), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerUpgradedGun, 20, { data: { level: 2 } }),
            event(EventType.PlayerFraggedPlayer, 25, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerFraggedPlayer, 30, { playerFrom: enemy, playerTo: eng, withWeapon: Weapon.Rocket }),
            event(EventType.PlayerUpgradedGun, 40, { data: { level: 3 } }),
            event(EventType.PlayerFraggedPlayer, 45, { playerTo: enemy, withWeapon: Weapon.BuildingSentryGun }),
            event(EventType.PlayerFraggedPlayer, 46, { playerTo: mate, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerRepairedBuilding, 50, { data: { building: Weapon.SentryGun } }),
            event(EventType.PlayerFraggedGun, 70, { playerFrom: enemy, playerTo: eng, withWeapon: Weapon.Rocket }),
        ], 100, [output()])[0];
        expect(stats).toMatchObject({ engineerSeconds: 100, builds: 1, upgrades: 2, repairs: 1,
            uptimeSeconds: 60, uptimePercentRound: 60, uptimePercentEngineer: 60,
            levelSeconds: { 1: 10, 2: 20, 3: 30, unknown: 0 },
            killsByLevel: { 1: 0, 2: 1, 3: 1, unknown: 0 }, totalKills: 2, teamKills: 1,
            destroyed: 1, dismantled: 0, detonated: 0, longestLifeSeconds: 60, warnings: [] });
        expect(stats.lives).toEqual([{ startSeconds: 10, endSeconds: 70, endReason: 'destroyed',
            confidence: 'observed', levelSeconds: { 1: 10, 2: 20, 3: 30, unknown: 0 },
            killsByLevel: { 1: 0, 2: 1, 3: 1, unknown: 0 }, levelSegments: [
                { startSeconds: 10, endSeconds: 20, level: 1 },
                { startSeconds: 20, endSeconds: 40, level: 2 },
                { startSeconds: 40, endSeconds: 70, level: 3 },
            ] }]);
    });

    it('applies teammate upgrades and repairs to the target gun owner', () => {
        const stats = trackSentries([role(-1), role(-1, PlayerClass.Engineer, mate),
            event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerUpgradedOtherGun, 20, { playerFrom: mate, playerTo: eng, data: { level: 2 } }),
            event(EventType.PlayerRepairedBuilding, 25, { playerFrom: mate, playerTo: eng, data: { building: Weapon.SentryGun } }),
            event(EventType.PlayerFraggedPlayer, 30, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
        ], 100, [output(), output(mate)]);
        expect(stats.find(s => s.steamId === eng.steamID)).toMatchObject({ builds: 1, upgrades: 1, repairs: 1,
            levelSeconds: { 1: 10, 2: 80, 3: 0, unknown: 0 }, killsByLevel: { 1: 0, 2: 1, 3: 0, unknown: 0 } });
        expect(stats.find(s => s.steamId === mate.steamID)).toMatchObject({ builds: 0, upgrades: 0, repairs: 0, uptimeSeconds: 0 });
    });

    it('bounds missing-build history at first evidence and never invents level one', () => {
        const stats = trackSentries([
            event(EventType.PlayerFraggedPlayer, 20, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerUpgradedGun, 40, { data: { level: 3 } }),
            event(EventType.PlayerFraggedPlayer, 50, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
        ], 100, [])[0];
        expect(stats).toMatchObject({ engineerSeconds: null, builds: 0, uptimeSeconds: 80,
            uptimePercentEngineer: null, levelSeconds: { 1: 0, 2: 0, 3: 60, unknown: 20 },
            killsByLevel: { 1: 0, 2: 0, 3: 1, unknown: 1 }, totalKills: 2 });
        expect(stats.warnings.length).toBeGreaterThan(0);
        expect(stats.lives[0].confidence).toBe('incomplete');
    });

    it('keeps unknown prior level when a logged build is followed by a missing intermediate upgrade', () => {
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerFraggedPlayer, 20, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerUpgradedGun, 40, { data: { level: 3 } }),
        ], 100, [output()])[0];
        expect(stats.levelSeconds).toEqual({ 1: 0, 2: 0, 3: 60, unknown: 30 });
        expect(stats.killsByLevel).toEqual({ 1: 0, 2: 0, 3: 0, unknown: 1 });
        expect(stats.lives[0].confidence).toBe('incomplete');
    });

    it('counts removals independently, ignores dispenser actions, and closes replacements', () => {
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerDetonatedBuilding, 15, { data: { building: Weapon.BuildingDispenser } }),
            event(EventType.PlayerDismantledBuilding, 20, { data: { building: Weapon.SentryGun } }),
            event(EventType.PlayerBuiltSentryGun, 30),
            event(EventType.PlayerDetonatedBuilding, 50, { data: { building: Weapon.SentryGun } }),
            event(EventType.PlayerBuiltSentryGun, 60), event(EventType.PlayerBuiltSentryGun, 80),
        ], 100, [output()])[0];
        expect(stats).toMatchObject({ builds: 4, destroyed: 0, dismantled: 1, detonated: 1,
            uptimeSeconds: 70, longestLifeSeconds: 20 });
        expect(stats.lives.map(l => l.endReason)).toEqual(['dismantled', 'detonated', 'replaced', 'round-end']);
    });

    it('intersects engineer intervals with standing time when class changes leave removal uncertain', () => {
        const stats = trackSentries([role(-10), event(EventType.PlayerBuiltSentryGun, 10),
            role(30, PlayerClass.Soldier), role(70),
            event(EventType.PlayerFraggedPlayer, 80, { playerTo: enemy, withWeapon: Weapon.SentryGun }),
        ], 100, [output(eng, 60)])[0];
        expect(stats).toMatchObject({ engineerSeconds: 60, uptimeSeconds: 90, uptimePercentRound: 90 });
        expect(stats.uptimePercentEngineer).toBeCloseTo(100 * 50 / 60);
        expect(stats.warnings.length).toBeGreaterThan(0);
    });

    it('ends standing time and engineer intervals on disconnect and team change', () => {
        const red = new Player(eng.steamID, eng.name, eng.playerID, TeamColor.Red);
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerLeftServer, 25), role(35), event(EventType.PlayerBuiltSentryGun, 40),
            event(EventType.PlayerJoinTeam, 60, { data: { team: TeamColor.Red } }),
            role(65, PlayerClass.Engineer, red), event(EventType.PlayerBuiltSentryGun, 70, { playerFrom: red }),
        ], 100, [output(eng, 50), output(red, 35)]);
        expect(stats.find(s => s.team === TeamColor.Blue)).toMatchObject({ engineerSeconds: 50, uptimeSeconds: 35 });
        expect(stats.find(s => s.team === TeamColor.Blue)?.lives.map(l => l.endReason)).toEqual(['disconnect', 'team-change']);
        expect(stats.find(s => s.team === TeamColor.Red)).toMatchObject({ engineerSeconds: 35, uptimeSeconds: 30 });
    });

    it('uses line order at equal time and excludes out-of-round gun events while retaining prematch roles', () => {
        const build = event(EventType.PlayerBuiltSentryGun, 10, { lineNumber: 1 });
        const upgrade = event(EventType.PlayerUpgradedGun, 10, { lineNumber: 2, data: { level: 2 } });
        const kill = event(EventType.PlayerFraggedPlayer, 10, { lineNumber: 3, playerTo: enemy, withWeapon: Weapon.SentryGun });
        const input = [kill, upgrade, build, role(-5), event(EventType.PlayerBuiltSentryGun, -1),
            event(EventType.PlayerBuiltSentryGun, 110), role(120, PlayerClass.Soldier)];
        const stats = trackSentries(input, 100, [output()])[0];
        expect(stats).toMatchObject({ builds: 1, engineerSeconds: 100, uptimeSeconds: 90,
            killsByLevel: { 1: 0, 2: 1, 3: 0, unknown: 0 } });
        expect(input[0]).toBe(kill);
    });

    it('returns null percentages for a zero-length round and bounded first evidence on destruction', () => {
        const stats = trackSentries([event(EventType.PlayerFraggedGun, 0, { playerFrom: enemy, playerTo: eng })], 0, [])[0];
        expect(stats).toMatchObject({ destroyed: 1, uptimeSeconds: 0, uptimePercentRound: null, uptimePercentEngineer: null });
        expect(stats.lives[0]).toMatchObject({ startSeconds: 0, endSeconds: 0, confidence: 'incomplete' });
    });

    it('leaves engineer duration unknown when class evidence starts mid-round', () => {
        const stats = trackSentries([role(20), event(EventType.PlayerBuiltSentryGun, 30)], 100, [])[0];
        expect(stats).toMatchObject({ engineerSeconds: null, uptimeSeconds: 70, uptimePercentEngineer: null });
    });

    it('does not divide total standing time by an aggregate without reconstructible engineer intervals', () => {
        const stats = trackSentries([event(EventType.PlayerBuiltSentryGun, 10)], 100, [output(eng, 40)])[0];
        expect(stats).toMatchObject({ engineerSeconds: 40, uptimeSeconds: 90, uptimePercentEngineer: null });
        expect(stats.warnings.length).toBeGreaterThan(0);
    });

    it('counts team kills separately and leaves unknown-team victims unattributed', () => {
        const unknown = new Player('STEAM_0:1:4', 'Unknown', 4, TeamColor.None);
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerFraggedPlayer, 20, { playerTo: mate, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerFraggedPlayer, 30, { playerTo: unknown, withWeapon: Weapon.SentryGun }),
        ], 100, [output()])[0];
        expect(stats).toMatchObject({ totalKills: 0, teamKills: 1,
            killsByLevel: { 1: 0, 2: 0, 3: 0, unknown: 0 } });
        expect(stats.warnings.length).toBeGreaterThan(0);
    });

    it('attributes a final same-second projectile kill after destruction without resurrecting the gun', () => {
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerUpgradedGun, 20, { data: { level: 2 } }),
            event(EventType.PlayerUpgradedGun, 30, { data: { level: 3 } }),
            event(EventType.PlayerFraggedGun, 40, { lineNumber: 400, playerFrom: enemy, playerTo: eng }),
            event(EventType.PlayerFraggedPlayer, 40, { lineNumber: 401, playerTo: enemy, withWeapon: Weapon.SentryGun }),
            event(EventType.PlayerBuiltSentryGun, 60),
        ], 100, [output()])[0];
        expect(stats).toMatchObject({ builds: 2, uptimeSeconds: 70, totalKills: 1,
            killsByLevel: { 1: 0, 2: 0, 3: 1, unknown: 0 }, warnings: [] });
        expect(stats.lives).toHaveLength(2);
        expect(stats.lives[0].killsByLevel).toEqual({ 1: 0, 2: 0, 3: 1, unknown: 0 });
    });

    it('retains gun ownership on a same-team join and starts a new unknown life after decreasing upgrade levels', () => {
        const stats = trackSentries([role(-1), event(EventType.PlayerBuiltSentryGun, 10),
            event(EventType.PlayerUpgradedGun, 20, { data: { level: 2 } }),
            event(EventType.PlayerUpgradedGun, 30, { data: { level: 3 } }),
            event(EventType.PlayerJoinTeam, 35, { data: { team: TeamColor.Blue } }),
            event(EventType.PlayerUpgradedGun, 50, { data: { level: 2 } }),
        ], 100, [output()])[0];
        expect(stats).toMatchObject({ uptimeSeconds: 90, builds: 1, upgrades: 3,
            levelSeconds: { 1: 10, 2: 60, 3: 20, unknown: 0 } });
        expect(stats.lives.map(l => l.endReason)).toEqual(['replaced', 'round-end']);
        expect(stats.lives.every(l => l.confidence === 'incomplete')).toBe(true);
    });

    it('omits transient prematch engineers with no playing engineer time or gun activity', () => {
        const stats = trackSentries([role(-20), role(-10, PlayerClass.Soldier)], 100,
            [{ ...output(eng, 0), classes: [{ class: PlayerClass.Soldier, classAsString: 'soldier', timeInSeconds: 100 }] }]);
        expect(stats).toEqual([]);
    });
});
