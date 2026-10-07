"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { importNoNameStats } = require("../lib/noNameStatsImport");
const a = { steamID: "STEAM_0:1:1", name: "Engineer", team: 1 };
const b = { steamID: "STEAM_0:0:2", name: "Scout", team: 2 };
const stat = value => ({ value });
function fixture() {
  const player = (p, team, kills) => ({ ...p, team, kills: { kill: stat(kills), sg: stat(2), teamkill: stat(1) }, deaths: { death: stat(3), by_team: stat(1), by_self: stat(2) }, damage: { to_enemies: stat(123), from_enemies: stat(50), from_team: stat(10) }, objectives: { flag_touch: stat(2), flag_capture: stat(1), flag_time_in_seconds: stat(15), toss_percent: stat(50) }, weaponStats: { concs: stat(4) }, classes: [{ classAsString: "engineer", timeInSeconds: 60 }], is_mvp: p === a });
  return { schemaVersion: 1, matchId: "match1", sourceHash: "abc", map: "2fort", players: { 1: [a], 2: [b] }, rounds: [1, 2].map(round => ({ round, durationSeconds: 60, score: { 1: 10, 2: 0 }, teams: { 1: { players: [player(round === 1 ? a : b, 1, 5)], teamStats: { teamRole: 0 } }, 2: { players: [player(round === 1 ? b : a, 2, 1)], teamStats: { teamRole: 1 } } }, sentry: [{ steamId: a.steamID, team: round === 1 ? 1 : 2, totalKills: 4, uptimeSeconds: 45, engineerSeconds: 60, uptimePercentEngineer: 75, levelSeconds: { 1: 10, 2: 10, 3: 25, unknown: 0 }, killsByLevel: { 1: 0, 2: 1, 3: 3, unknown: 0 }, lives: [{ startSeconds: 5, endSeconds: 50, endReason: "destroyed", confidence: "observed", levelSeconds: { 3: 45 }, killsByLevel: { 3: 4 } }], warnings: [] }] })), events: [{ round: 2, timeSeconds: 12, type: "PlayerFraggedPlayer", playerFrom: { steamId: a.steamID, name: a.name, team: 2, className: "engineer" }, playerTo: { steamId: b.steamID, name: b.name, team: 1 }, weapon: "sentry gun", weaponId: 15, whileConced: true, playerToWasCarryingFlag: true }, { round: 2, timeSeconds: 25, type: "PlayerCapturedFlag", playerFrom: { steamId: b.steamID, name: b.name, team: 1 } }] };
}
test("imports structured stats with original teams, legacy SG meaning and exact identities", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE matches(match_id TEXT PRIMARY KEY,winner TEXT,blue_score INTEGER); INSERT INTO matches VALUES('match1','blue',99); CREATE TABLE ratings(player_id TEXT,rating INTEGER); INSERT INTO ratings VALUES('discord1',1500); CREATE TABLE player_steam_ids(steam_id TEXT,discord_id TEXT,is_primary INTEGER); INSERT INTO player_steam_ids VALUES('STEAM_0:1:1','discord1',1)");
  importNoNameStats({ db, result: fixture(), sourceUrl: "http://parser/matches/match1" });
  assert.equal(db.prepare("SELECT kills FROM match_player_stats WHERE player_key=?").get(a.steamID).kills, 6);
  assert.deepEqual(db.prepare("SELECT team_name,sentry_kills FROM match_player_round_stats WHERE player_key=? AND round_num=2").get(a.steamID), { team_name: "Team A", sentry_kills: 2 });
  assert.deepEqual(db.prepare("SELECT attacker_team,victim_team,attacker_discord_id,weapon,is_conced,is_flag_carrier_kill FROM match_kill_events").get(), { attacker_team: "Team A", victim_team: "Team B", attacker_discord_id: "discord1", weapon: "weapon-15", is_conced: 1, is_flag_carrier_kill: 1 });
  assert.equal(db.prepare("SELECT kills FROM match_player_weapons").get().kills, 1);
  assert.equal(db.prepare("SELECT total_kills FROM match_sentry_round_stats LIMIT 1").get().total_kills, 4);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_sentry_lives").get().n, 2);
  assert.equal(db.prepare("SELECT team1_score FROM match_rounds WHERE round_num=2").get().team1_score, 0);
  assert.equal(db.prepare("SELECT team FROM match_cap_events").get().team, "red");
  assert.equal(db.prepare("SELECT capper_name FROM match_cap_events").get().capper_name, "Scout");
  assert.equal(db.prepare("SELECT flag_event_type FROM match_flag_events WHERE subtype='PlayerCapturedFlag'").get().flag_event_type, "cap");
  assert.equal(db.prepare("SELECT winner,blue_score FROM matches").get().blue_score, 99);
  assert.equal(db.prepare("SELECT rating FROM ratings").get().rating, 1500);
  db.close();
});
test("reruns replace only the match statistics and rollback failed replacement", () => {
  const db = new Database(":memory:");
  const result = fixture();
  importNoNameStats({ db, result });
  importNoNameStats({ db, result });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_kill_events").get().n, 1);
  db.exec("CREATE TRIGGER reject_stats BEFORE INSERT ON match_player_stats BEGIN SELECT RAISE(ABORT,'blocked'); END");
  assert.throws(() => importNoNameStats({ db, result }), /blocked/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_player_stats").get().n, 2);
  assert.equal(db.prepare("SELECT status FROM match_stat_imports").get().status, "ok");
  db.close();
});
test("migrates missing legacy columns and rejects malformed results before deleting data", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE match_player_stats(match_id TEXT,player_key TEXT,kills INTEGER,PRIMARY KEY(match_id,player_key))");
  importNoNameStats({ db, result: fixture() });
  assert.equal(db.prepare("SELECT enemy_damage FROM match_player_stats LIMIT 1").get().enemy_damage, 246);
  assert.throws(() => importNoNameStats({ db, result: { ...fixture(), rounds: [] } }), /round/i);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_player_stats").get().n, 2);
  db.close();
});

test("schema migration preserves older match data without labeling it as a local import", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE match_player_stats(match_id TEXT,player_key TEXT,kills INTEGER,PRIMARY KEY(match_id,player_key)); INSERT INTO match_player_stats VALUES('older','STEAM_0:1:99',42)");
  importNoNameStats({ db, result: fixture() });
  assert.deepEqual(db.prepare("SELECT kills,source FROM match_player_stats WHERE match_id='older'").get(), { kills: 42, source: "legacy" });
  assert.equal(db.prepare("SELECT source FROM match_player_stats WHERE match_id='match1' LIMIT 1").get().source, "noname");
  db.close();
});

test("retains separate SG history for both observed teams after a mid-round team change", () => {
  const db = new Database(":memory:");
  const result = fixture();
  const first = result.rounds[0].sentry[0];
  result.rounds[0].sentry.push({ ...first, team: 2, totalKills: 2, uptimeSeconds: 10,
    lives: [{ ...first.lives[0], startSeconds: 50, endSeconds: 60 }] });
  importNoNameStats({ db, result });
  assert.deepEqual(db.prepare("SELECT observed_team,total_kills FROM match_sentry_round_stats WHERE round_num=1 ORDER BY observed_team").all(), [{ observed_team: 1, total_kills: 4 }, { observed_team: 2, total_kills: 2 }]);
  assert.deepEqual(db.prepare("SELECT observed_team,life_num FROM match_sentry_lives WHERE round_num=1 ORDER BY observed_team").all(), [{ observed_team: 1, life_num: 1 }, { observed_team: 2, life_num: 1 }]);
  importNoNameStats({ db, result });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_sentry_lives").get().n, 3);
  db.close();
});
test("normalizes upstream prefix-free Steam IDs and marks imported rows with own provenance", () => {
  const db = new Database(":memory:");
  const result = JSON.parse(JSON.stringify(fixture()).replaceAll("STEAM_", ""));
  importNoNameStats({ db, result });
  assert.equal(db.prepare("SELECT player_key,source,team FROM match_player_stats ORDER BY player_key DESC").get().player_key, a.steamID);
  for (const table of ["match_player_stats", "match_player_round_stats", "match_player_classes", "match_player_weapons", "match_rounds", "match_cap_events"]) {
    assert.equal(db.prepare(`SELECT source FROM ${table} LIMIT 1`).get().source, "noname");
  }
  assert.equal(db.prepare("SELECT weapon_name FROM match_player_weapons").get().weapon_name, "sentry gun");
  db.close();
});
test("preserves the complete structured Hampalyzer result and atomically replaces it on reimport", () => {
  const db = new Database(":memory:"); const result = fixture();
  result.parserVersion = "nn-parser-v1"; result.parsedAt = "2026-10-07T12:00:00.000Z";
  result.hampalyzer = { comparison: { offense: { caps: 12 } }, scoring_activity: { flag_movements: { 1: [{ type: 0, game_time_as_seconds: 8 }] } } };
  importNoNameStats({ db, result, sourceUrl: "https://example/match1" });
  let saved = db.prepare("SELECT * FROM match_parser_results").get();
  assert.deepEqual(JSON.parse(saved.result_json), result); assert.equal(saved.source_hash, "abc");
  result.sourceHash = "replacement"; result.hampalyzer.comparison.offense.caps = 13;
  importNoNameStats({ db, result });
  saved = db.prepare("SELECT * FROM match_parser_results").get();
  assert.equal(saved.source_hash, "replacement"); assert.equal(JSON.parse(saved.result_json).hampalyzer.comparison.offense.caps, 13);
  db.exec("CREATE TRIGGER reject_payload BEFORE INSERT ON match_parser_results BEGIN SELECT RAISE(ABORT,'payload blocked'); END");
  result.sourceHash = "must-rollback";
  assert.throws(() => importNoNameStats({ db, result }), /payload blocked/);
  assert.equal(db.prepare("SELECT source_hash FROM match_parser_results").get().source_hash, "replacement");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM match_player_stats").get().n, 2);
  db.close();
});
module.exports = { fixture };
