import type { Event } from '../upstream/src/models/event.js';
import EventType from '../upstream/src/models/event-types.js';
import { PlayerClass, TeamColor, Weapon, type PlayerOutputStatsRound } from '../upstream/src/models/types.js';

export type SentryLevel = 1 | 2 | 3 | 'unknown';
export type SentryLevelCounts = Record<SentryLevel, number>;
export type SentryEndReason = 'destroyed' | 'dismantled' | 'detonated' | 'disconnect' | 'team-change' | 'replaced' | 'round-end';
export interface SentryLevelSegment { startSeconds: number; endSeconds: number; level: SentryLevel }
export interface SentryLife {
    startSeconds: number;
    endSeconds: number;
    endReason: SentryEndReason;
    levelSeconds: SentryLevelCounts;
    killsByLevel: SentryLevelCounts;
    confidence: 'observed' | 'incomplete';
    levelSegments: SentryLevelSegment[];
}
export interface SentryPlayerStats {
    steamId: string;
    name: string;
    team: number;
    engineerSeconds: number | null;
    builds: number;
    upgrades: number;
    repairs: number;
    uptimeSeconds: number;
    uptimePercentRound: number | null;
    uptimePercentEngineer: number | null;
    levelSeconds: SentryLevelCounts;
    killsByLevel: SentryLevelCounts;
    totalKills: number;
    teamKills: number;
    destroyed: number;
    dismantled: number;
    detonated: number;
    longestLifeSeconds: number;
    lives: SentryLife[];
    warnings: string[];
}

type Reference = { steamID: string; name: string; team: number };
type Interval = { start: number; end: number };
type WorkingSegment = SentryLevelSegment & { kills: number };
type WorkingLife = { start: number; segments: WorkingSegment[]; incomplete: boolean };
type State = {
    stats: SentryPlayerStats;
    output?: PlayerOutputStatsRound;
    gun?: WorkingLife;
    currentClass?: PlayerClass;
    firstClassTime?: number;
    classStart: number;
    intervals: Interval[];
};
const counts = (): SentryLevelCounts => ({ 1: 0, 2: 0, 3: 0, unknown: 0 });
const isGun = (weapon: Weapon | undefined): boolean => weapon === Weapon.SentryGun || weapon === Weapon.BuildingSentryGun;

/** Observed SG availability, with incomplete history bounded at its first evidence. */
export function trackSentries(events: Event[], durationSeconds: number, players: PlayerOutputStatsRound[]): SentryPlayerStats[] {
    const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    const clamp = (time: number): number => Math.min(duration, Math.max(0, time));
    const states = new Map<string, State>();
    const warn = (state: State, message: string): void => {
        if (!state.stats.warnings.includes(message)) state.stats.warnings.push(message);
    };
    const ensure = (ref: Reference): State => {
        const key = `${ref.steamID}/${ref.team}`;
        let state = states.get(key);
        if (!state) {
            state = { classStart: 0, intervals: [], stats: {
                steamId: ref.steamID, name: ref.name, team: ref.team, engineerSeconds: null,
                builds: 0, upgrades: 0, repairs: 0, uptimeSeconds: 0, uptimePercentRound: null,
                uptimePercentEngineer: null, levelSeconds: counts(), killsByLevel: counts(),
                totalKills: 0, teamKills: 0, destroyed: 0, dismantled: 0, detonated: 0,
                longestLifeSeconds: 0, lives: [], warnings: [],
            } };
            states.set(key, state);
        }
        return state;
    };
    const setClass = (state: State, playerClass: PlayerClass | undefined, time: number): void => {
        if (state.currentClass === playerClass) return;
        if (state.currentClass === PlayerClass.Engineer) {
            state.intervals.push({ start: state.classStart, end: time });
            if (state.gun && playerClass !== undefined) {
                state.gun.incomplete = true;
                warn(state, 'Owner changed class while a gun was standing; removal time is unobserved.');
            }
        }
        state.currentClass = playerClass;
        state.classStart = time;
        if (playerClass !== undefined) state.firstClassTime ??= time;
    };
    const start = (state: State, time: number, built: boolean): WorkingLife => {
        const gun: WorkingLife = { start: time, incomplete: !built,
            segments: [{ startSeconds: time, endSeconds: time, level: built ? 1 : 'unknown', kills: 0 }] };
        state.gun = gun;
        if (!built) warn(state, 'Gun build is missing; lifetime starts at first observed evidence and earlier level is unknown.');
        return gun;
    };
    const finish = (state: State, time: number, reason: SentryEndReason): void => {
        const gun = state.gun;
        if (!gun) return;
        gun.segments.at(-1)!.endSeconds = time;
        const life: SentryLife = { startSeconds: gun.start, endSeconds: time, endReason: reason,
            levelSeconds: counts(), killsByLevel: counts(), confidence: gun.incomplete ? 'incomplete' : 'observed',
            levelSegments: gun.segments.map(({ kills: _kills, ...segment }) => segment) };
        for (const segment of gun.segments) {
            const seconds = Math.max(0, segment.endSeconds - segment.startSeconds);
            life.levelSeconds[segment.level] += seconds;
            life.killsByLevel[segment.level] += segment.kills;
            state.stats.levelSeconds[segment.level] += seconds;
            state.stats.killsByLevel[segment.level] += segment.kills;
        }
        state.stats.uptimeSeconds += time - gun.start;
        state.stats.longestLifeSeconds = Math.max(state.stats.longestLifeSeconds, time - gun.start);
        state.stats.lives.push(life);
        state.gun = undefined;
    };
    for (const player of players) ensure(player).output = player;

    // Copy before sorting: the upstream event array is also consumed by other statistics.
    const ordered = events.filter(ev => Number.isFinite(ev.gameTimeAsSeconds))
        .slice().sort((a, b) => a.gameTimeAsSeconds - b.gameTimeAsSeconds || a.lineNumber - b.lineNumber);
    for (const ev of ordered) {
        if (ev.gameTimeAsSeconds > duration) continue;
        const time = clamp(ev.gameTimeAsSeconds);
        const from = ev.playerFrom ? ensure(ev.playerFrom) : undefined;
        const to = ev.playerTo ? ensure(ev.playerTo) : undefined;
        if (ev.eventType === EventType.PlayerChangeRole) {
            if (from && ev.data?.class !== undefined) setClass(from, ev.data.class, time);
            continue;
        }
        if (ev.eventType === EventType.PlayerLeftServer || ev.eventType === EventType.PlayerKicked) {
            if (from) for (const state of states.values()) {
                if (state.stats.steamId !== from.stats.steamId) continue;
                finish(state, time, 'disconnect');
                setClass(state, undefined, time);
            }
            continue;
        }
        if (ev.eventType === EventType.PlayerJoinTeam) {
            if (from && ev.data?.team !== undefined) for (const state of states.values()) {
                if (state.stats.steamId !== from.stats.steamId || state.stats.team === ev.data.team) continue;
                finish(state, time, 'team-change');
                setClass(state, undefined, time);
            }
            continue;
        }
        if (ev.gameTimeAsSeconds < 0) continue;
        if (from && ev.playerFromClass !== undefined) setClass(from, ev.playerFromClass, time);
        if (to && ev.playerToClass !== undefined) setClass(to, ev.playerToClass, time);

        switch (ev.eventType) {
            case EventType.PlayerBuiltSentryGun:
                if (!from) break;
                if (from.gun) {
                    from.gun.incomplete = true;
                    warn(from, 'A new build replaced a gun without a logged removal.');
                    finish(from, time, 'replaced');
                }
                from.stats.builds++;
                start(from, time, true);
                break;
            case EventType.PlayerUpgradedGun:
            case EventType.PlayerUpgradedOtherGun: {
                const owner = ev.eventType === EventType.PlayerUpgradedOtherGun ? to : from;
                if (!owner) {
                    if (from) warn(from, 'Teammate upgrade has no target; gun ownership is unknown.');
                    break;
                }
                owner.stats.upgrades++;
                let gun = owner.gun ?? start(owner, time, false);
                let previous = gun.segments.at(-1)!;
                const level: SentryLevel = ev.data?.level === 2 || ev.data?.level === 3 ? ev.data.level : 'unknown';
                if (typeof previous.level === 'number' && typeof level === 'number' && level < previous.level) {
                    gun.incomplete = true;
                    warn(owner, 'Upgrade level decreased; an unlogged replacement may have occurred.');
                    finish(owner, time, 'replaced');
                    gun = start(owner, time, false);
                    previous = gun.segments.at(-1)!;
                }
                if (typeof previous.level === 'number' && typeof level === 'number' && level > previous.level + 1) {
                    // No timestamp identifies when the missing intermediate upgrade happened.
                    previous.level = 'unknown';
                    gun.incomplete = true;
                    warn(owner, 'An intermediate upgrade is missing; its preceding segment and kills have unknown level.');
                }
                if (level === 'unknown') {
                    gun.incomplete = true;
                    warn(owner, 'Upgrade level is missing or invalid.');
                }
                previous.endSeconds = time;
                gun.segments.push({ startSeconds: time, endSeconds: time, level, kills: 0 });
                break;
            }
            case EventType.PlayerRepairedBuilding: {
                if (!isGun(ev.data?.building)) break;
                const owner = to ?? from;
                if (!owner) break;
                owner.stats.repairs++;
                owner.gun ?? start(owner, time, false);
                break;
            }
            case EventType.PlayerFraggedPlayer: {
                if (!from || !isGun(ev.withWeapon)) break;
                const lastLife = from.stats.lives.at(-1);
                // Real logs emit SG projectile victims after Sentry_Destroyed in the same second.
                // A completed lifetime is still the source of that projectile, not a new standing gun.
                const finalProjectile = !from.gun && lastLife?.endSeconds === time &&
                    ['destroyed', 'detonated', 'dismantled'].includes(lastLife.endReason) ? lastLife : undefined;
                const gun = finalProjectile ? undefined : from.gun ?? start(from, time, false);
                if (from.stats.team < TeamColor.Blue || from.stats.team > TeamColor.Green ||
                    !ev.playerTo || ev.playerTo.team < TeamColor.Blue || ev.playerTo.team > TeamColor.Green) {
                    warn(from, 'A sentry victim or owner has unknown team; the kill is excluded from enemy and team kill totals.');
                } else if (ev.playerTo.team === from.stats.team) {
                    from.stats.teamKills++;
                } else {
                    if (finalProjectile) {
                        const level = finalProjectile.levelSegments.at(-1)!.level;
                        finalProjectile.killsByLevel[level]++;
                        from.stats.killsByLevel[level]++;
                    } else gun!.segments.at(-1)!.kills++;
                    from.stats.totalKills++;
                }
                break;
            }
            case EventType.PlayerFraggedGun:
                if (!to) break;
                to.stats.destroyed++;
                to.gun ?? start(to, time, false);
                finish(to, time, 'destroyed');
                break;
            case EventType.PlayerDetonatedBuilding:
            case EventType.PlayerDismantledBuilding: {
                if (!from || !isGun(ev.data?.building)) break;
                const reason = ev.eventType === EventType.PlayerDetonatedBuilding ? 'detonated' : 'dismantled';
                from.stats[reason]++;
                from.gun ?? start(from, time, false);
                finish(from, time, reason);
                break;
            }
        }
    }

    for (const state of states.values()) {
        finish(state, duration, 'round-end');
        if (state.currentClass === PlayerClass.Engineer) state.intervals.push({ start: state.classStart, end: duration });
        const observedEngineerSeconds = state.intervals.reduce((sum, interval) => sum + Math.max(0, interval.end - interval.start), 0);
        const classTimes = state.output?.classes;
        const aggregateKnown = classTimes && classTimes.length > 0 && classTimes.every(c => Number.isFinite(c.timeInSeconds) && c.timeInSeconds >= 0);
        state.stats.engineerSeconds = aggregateKnown
            ? Math.min(duration, classTimes.filter(c => c.class === PlayerClass.Engineer).reduce((sum, c) => sum + c.timeInSeconds, 0))
            : state.firstClassTime === 0 ? observedEngineerSeconds : null;
        state.stats.uptimePercentRound = duration > 0 ? 100 * state.stats.uptimeSeconds / duration : null;
        const engineerSeconds = state.stats.engineerSeconds;
        if (engineerSeconds !== null && engineerSeconds > 0 && Math.abs(engineerSeconds - observedEngineerSeconds) < 0.001) {
            let engineerUptime = 0;
            for (const life of state.stats.lives) for (const interval of state.intervals) {
                engineerUptime += Math.max(0, Math.min(life.endSeconds, interval.end) - Math.max(life.startSeconds, interval.start));
            }
            state.stats.uptimePercentEngineer = 100 * engineerUptime / engineerSeconds;
        } else if (state.stats.lives.length > 0 && engineerSeconds !== 0) {
            warn(state, 'Engineer intervals are unavailable or incomplete; engineer-relative uptime is unknown.');
        }
    }
    return [...states.values()].filter(s => (s.stats.engineerSeconds ?? 0) > 0 ||
        s.intervals.some(interval => interval.end > interval.start) || s.stats.lives.length > 0 || s.stats.warnings.length > 0)
        .map(s => s.stats).sort((a, b) => a.steamId.localeCompare(b.steamId) || a.team - b.team);
}
