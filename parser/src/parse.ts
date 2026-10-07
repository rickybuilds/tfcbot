import { Parser, type ParsedStats } from '../upstream/src/parsing/match-parser.js';
import { basename } from 'node:path';
import { EventType } from '../upstream/src/models/event-types.js';
import { DisplayStringHelper, Weapon, type TeamsOutputStatsDetailed } from '../upstream/src/models/types.js';
import type Player from '../upstream/src/models/player.js';
import type { Event } from '../upstream/src/models/event.js';
import { trackSentries, type SentryPlayerStats } from './sentry.js';

export const PARSER_VERSION = 'nn-parser-v1';
export interface PlayerReference { steamId: string; name: string; team: number; className?: string }
export interface MatchEvent {
  round: number; timeSeconds: number; type: string; playerFrom?: PlayerReference; playerTo?: PlayerReference;
  weapon?: string; weaponId?: number; whileConced: boolean;
  playerFromWasCarryingFlag: boolean; playerToWasCarryingFlag: boolean;
  data?: { level?: number; building?: number; class?: number; team?: number; value?: string };
}
export interface MatchResult {
  schemaVersion: 1; parserVersion: string; matchId: string; parsedAt: string; sourceHash: string;
  map: string; isValid: boolean; players: unknown; parsingErrors: (string[] | undefined)[];
  rounds: { round: number; durationSeconds: number; score: Record<string, number | undefined>; teams: TeamsOutputStatsDetailed; sentry: SentryPlayerStats[] }[];
  events: MatchEvent[];
  hampalyzer: Omit<ParsedStats, 'rawStats'>;
}

const publicEvents = new Set([
  EventType.PlayerFraggedPlayer, EventType.PlayerFraggedGun, EventType.PlayerCommitSuicide,
  EventType.PlayerDamage, EventType.PlayerBuiltSentryGun, EventType.PlayerUpgradedGun,
  EventType.PlayerUpgradedOtherGun, EventType.PlayerRepairedBuilding, EventType.PlayerDetonatedBuilding,
  EventType.PlayerDismantledBuilding, EventType.PlayerPickedUpFlag, EventType.PlayerPickedUpBonusFlag,
  EventType.PlayerThrewFlag, EventType.PlayerCapturedFlag, EventType.PlayerCapturedBonusFlag,
  EventType.PlayerGainedFlagWithLocation, EventType.PlayerDroppedFlagViaDeathWithLocation,
  EventType.FlagReturn, EventType.PlayerChangeRole, EventType.PlayerJoinTeam, EventType.PlayerLeftServer,
]);
const canonicalSteam = (id: string) => /^\d:[01]:\d+$/.test(id) ? `STEAM_${id}` : id.toUpperCase();
function reference(player: Player | undefined, playerClass?: number): PlayerReference | undefined {
  if (!player) return undefined;
  return { steamId: canonicalSteam(player.steamID), name: player.name, team: player.team,
    ...(playerClass === undefined ? {} : { className: DisplayStringHelper.classToDisplayString(playerClass) }) };
}
function publicEvent(event: Event, round: number): MatchEvent {
  const data = event.data;
  return {
    round, timeSeconds: event.gameTimeAsSeconds, type: EventType[event.eventType],
    playerFrom: reference(event.playerFrom, event.playerFromClass), playerTo: reference(event.playerTo, event.playerToClass),
    ...(event.withWeapon === undefined ? {} : { weapon: DisplayStringHelper.weaponToDisplayString(event.withWeapon), weaponId: event.withWeapon }),
    whileConced: event.whileConced, playerFromWasCarryingFlag: event.playerFromWasCarryingFlag,
    playerToWasCarryingFlag: event.playerToWasCarryingFlag,
    ...(data ? { data: { level: data.level, building: data.building, class: data.class, team: data.team,
      ...(event.eventType === EventType.PlayerDamage && /^\d+$/.test(data.value || '') ? { value: data.value } : {}) } } : {}),
  };
}

export async function parseLogs(files: string[], options: { matchId: string; force?: boolean; sourceHash?: string }): Promise<MatchResult> {
  if (files.length < 1 || files.length > 2) throw new Error('Provide one or two round logs.');
  const parsed = await new Parser(...files).parseRounds(options.force);
  const diagnostics = parsed.parsing_errors.map(errors => errors?.map((error, index) => {
    const line = error.match(/(?:line|Line)\s*(\d+)/)?.[1];
    return line ? `Log line ${line} could not be parsed.` : `Unrecognized log event ${index + 1}.`;
  }));
  const { rawStats: _rawStats, ...summary } = parsed;
  const hampalyzer = JSON.parse(JSON.stringify({ ...summary, parsing_errors: diagnostics }, (key, value) => {
    if (key === 'events' || key === 'rawLine') return undefined;
    if (key === 'log_name' && typeof value === 'string') return basename(value);
    if (key === 'parsing_errors') return Array.isArray(value) && value.some(Array.isArray) ? value : [];
    if (key === 'steamID' && typeof value === 'string') return canonicalSteam(value);
    if (key === 'player' && value && typeof value === 'object') return reference(value);
    return value;
  })) as Omit<ParsedStats, 'rawStats'>;
  const rounds = parsed.stats.map((stats, index) => {
    if (!stats) throw new Error('A round did not produce stats.');
    const durationSeconds = stats.scoring_activity?.game_time_as_seconds || 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('The log has no measurable playing time.');
    const players = Object.values(stats.teams).flatMap(team => team?.players || []);
    // Keep upstream normal stats; omit raw events and internal Player object state.
    const teams = JSON.parse(JSON.stringify(stats.teams, (key, value) => {
      if (key === 'events' || key === 'rawLine') return undefined;
      if (key === 'steamID' && typeof value === 'string') return canonicalSteam(value);
      if (key === 'player' && value && typeof value === 'object') return reference(value);
      return value;
    })) as TeamsOutputStatsDetailed;
    return { round: index + 1, durationSeconds, score: stats.score, teams,
      sentry: trackSentries(parsed.rawStats.events[index], durationSeconds, players).map(player => ({ ...player, steamId: canonicalSteam(player.steamId) })) };
  });
  return {
    schemaVersion: 1, parserVersion: PARSER_VERSION, matchId: options.matchId,
    parsedAt: new Date().toISOString(), sourceHash: options.sourceHash || '',
    map: parsed.stats[0]!.map, isValid: parsed.isValid,
    players: JSON.parse(JSON.stringify(parsed.players, (key, value) => key === 'steamID' ? canonicalSteam(value) : value)),
    parsingErrors: diagnostics, hampalyzer,
    rounds, events: parsed.rawStats.events.flatMap((events, index) => events
      .filter(event => publicEvents.has(event.eventType) && event.gameTimeAsSeconds >= 0 && event.gameTimeAsSeconds <= rounds[index].durationSeconds)
      .map(event => publicEvent(event, index + 1))),
  };
}
