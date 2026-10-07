"use strict";

const Database = require("better-sqlite3");

// These are the website's existing column names. In particular sentry_kills is
// guns destroyed, whereas match_sentry_round_stats.total_kills is player kills.
const ROUND_STATS = {
  kills: ["kills", "kill"], team_kills: ["kills", "teamkill"], conced_kills: ["kills", "kill_while_conced"], sentry_kills: ["kills", "sg"],
  deaths_by_enemy: ["deaths", "death"], deaths_by_team: ["deaths", "by_team"], suicides: ["deaths", "by_self"],
  enemy_damage: ["damage", "to_enemies"], team_damage: ["damage", "to_team"], damage_taken_enemy: ["damage", "from_enemies"], damage_taken_team: ["damage", "from_team"], self_damage: ["damage", "to_self"],
  conc_jumps: ["weaponStats", "concs"], flag_captures: ["objectives", "flag_capture"], flag_touches: ["objectives", "flag_touch"], initial_touches: ["objectives", "touches_initial"], flag_time_seconds: ["objectives", "flag_time_in_seconds"]
};
const numericColumns = Object.fromEntries(Object.keys(ROUND_STATS).map(k => [k, "REAL DEFAULT 0"]));
const identity = { match_id: "TEXT NOT NULL", player_key: "TEXT NOT NULL", steam_id: "TEXT", display_name: "TEXT" };
const schemas = {
  match_parser_results: [{ match_id: "TEXT PRIMARY KEY", schema_version: "INTEGER NOT NULL", parser_version: "TEXT", source_hash: "TEXT", parsed_at: "TEXT", source_url: "TEXT", result_json: "TEXT NOT NULL" }],
  match_stat_imports: [{ match_id: "TEXT PRIMARY KEY", source: "TEXT", source_url: "TEXT", status: "TEXT", notes: "TEXT", imported_at: "INTEGER" }],
  match_player_stats: [{ ...identity, ...numericColumns, deaths: "REAL DEFAULT 0", damage_taken: "REAL DEFAULT 0", main_class: "TEXT" }, "match_id,player_key"],
  match_player_round_stats: [{ ...identity, round_num: "INTEGER NOT NULL", team_name: "TEXT", role: "TEXT", ...numericColumns, objectives: "REAL DEFAULT 0", toss_percent: "REAL" }, "match_id,player_key,round_num"],
  match_player_classes: [{ match_id: "TEXT NOT NULL", player_key: "TEXT NOT NULL", class_name: "TEXT NOT NULL", round_num: "INTEGER NOT NULL", seconds: "REAL" }, "match_id,player_key,class_name,round_num"],
  match_player_weapons: [{ match_id: "TEXT NOT NULL", player_key: "TEXT NOT NULL", weapon: "TEXT NOT NULL", kills: "INTEGER" }, "match_id,player_key,weapon"],
  match_rounds: [{ match_id: "TEXT NOT NULL", round_num: "INTEGER NOT NULL", map_name: "TEXT", duration_seconds: "REAL", team1_score: "REAL", team2_score: "REAL", offense_team: "TEXT", defense_team: "TEXT" }, "match_id,round_num"],
  match_round_mvps: [{ match_id: "TEXT NOT NULL", round_num: "INTEGER NOT NULL", mvp_display_name: "TEXT", mvp_player_key: "TEXT", steam_id: "TEXT" }, "match_id,round_num"],
  match_kill_events: [{ id: "INTEGER PRIMARY KEY AUTOINCREMENT", match_id: "TEXT NOT NULL", source_url: "TEXT", round_num: "INTEGER NOT NULL", event_time_seconds: "REAL", event_time_text: "TEXT", attacker_key: "TEXT NOT NULL", attacker_steam_id: "TEXT", attacker_discord_id: "TEXT", attacker_name: "TEXT", attacker_team: "TEXT", attacker_role: "TEXT", attacker_class: "TEXT", attacker_class_confidence: "TEXT", weapon: "TEXT NOT NULL", victim_name: "TEXT", victim_key: "TEXT", victim_steam_id: "TEXT", victim_discord_id: "TEXT", victim_team: "TEXT", is_enemy_kill: "INTEGER DEFAULT 1", is_team_kill: "INTEGER DEFAULT 0", is_conced: "INTEGER DEFAULT 0", is_flag_carrier_kill: "INTEGER DEFAULT 0", source_confidence: "TEXT NOT NULL DEFAULT 'exact'" }],
  match_cap_events: [{ id: "INTEGER PRIMARY KEY AUTOINCREMENT", match_id: "TEXT NOT NULL", source_url: "TEXT", team: "TEXT NOT NULL", cap_num: "INTEGER NOT NULL", time_seconds: "REAL NOT NULL", time_text: "TEXT NOT NULL", score_after: "REAL", capper_name: "TEXT", capper_steam_id: "TEXT", imported_at: "INTEGER" }],
  match_flag_events: [{ id: "INTEGER PRIMARY KEY AUTOINCREMENT", match_id: "TEXT NOT NULL", round_num: "INTEGER", game_time_seconds: "REAL", event_time_text: "TEXT", flag_event_type: "TEXT NOT NULL", subtype: "TEXT", meta: "TEXT", player_key: "TEXT", steam_id: "TEXT", display_name: "TEXT", team: "TEXT", class_name: "TEXT", conceded: "INTEGER DEFAULT 0", value: "TEXT", source: "TEXT NOT NULL DEFAULT 'noname'", source_url: "TEXT", other_display_name: "TEXT", other_player_key: "TEXT", other_steam_id: "TEXT", touches: "INTEGER", source_confidence: "TEXT" }],
  match_sentry_round_stats: [{ ...identity, round_num: "INTEGER NOT NULL", observed_team: "INTEGER NOT NULL", team_name: "TEXT", engineer_seconds: "REAL", builds: "INTEGER", upgrades: "INTEGER", repairs: "INTEGER", uptime_seconds: "REAL", uptime_percent_round: "REAL", uptime_percent_engineer: "REAL", total_kills: "INTEGER", team_kills: "INTEGER", destroyed: "INTEGER", dismantled: "INTEGER", detonated: "INTEGER", longest_life_seconds: "REAL", level_seconds: "TEXT", kills_by_level: "TEXT", warnings: "TEXT" }, "match_id,player_key,round_num,observed_team"],
  match_sentry_lives: [{ ...identity, round_num: "INTEGER NOT NULL", observed_team: "INTEGER NOT NULL", life_num: "INTEGER NOT NULL", start_seconds: "REAL", end_seconds: "REAL", end_reason: "TEXT", confidence: "TEXT", level_seconds: "TEXT", kills_by_level: "TEXT", level_segments: "TEXT" }, "match_id,player_key,round_num,observed_team,life_num"]
};

for (const table of ["match_player_stats", "match_player_round_stats", "match_player_classes", "match_player_weapons", "match_rounds", "match_cap_events"]) schemas[table][0].source = "TEXT NOT NULL DEFAULT 'noname'";
schemas.match_player_stats[0].team = "TEXT";
schemas.match_player_weapons[0].weapon_name = "TEXT";
schemas.match_kill_events[0].weapon_name = "TEXT";
schemas.match_kill_events[0].victim_class = "TEXT";

function ensureSchema(db) {
  for (const [table, [columns, primary]] of Object.entries(schemas)) {
    const definitions = Object.entries(columns).map(([name, type]) => `${name} ${type}`);
    if (primary) definitions.push(`PRIMARY KEY (${primary})`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${definitions.join(",")})`);
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, type] of Object.entries(columns)) {
      // Old installs may lack newer stat columns. Existing constraints/data stay.
      if (!present.has(name)) {
        // Migration must not relabel historical rows as local parser imports.
        const migrationType = name === "source" ? "TEXT DEFAULT 'legacy'" : type.replace(/PRIMARY KEY(?: AUTOINCREMENT)?|NOT NULL/g, "").trim();
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${migrationType}`);
      }
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_noname_kills_match ON match_kill_events(match_id,round_num); CREATE INDEX IF NOT EXISTS idx_noname_sentry_player ON match_sentry_round_stats(steam_id,match_id)");
}
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const steam = player => {
  const value = String(player?.steamId || player?.steamID || "").trim().toUpperCase();
  return /^[0-5]:[01]:\d+$/.test(value) ? `STEAM_${value}` : value;
};
const timeText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const json = value => JSON.stringify(value ?? {});
function insert(db, table, row) {
  if (schemas[table][0].source) row = { ...row, source: "noname" };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(k => row[k] ?? null));
}
function validateResult(result, matchId) {
  if (result?.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{1,80}$/.test(String(result?.matchId || "")) || (matchId && String(matchId) !== result.matchId)) throw new Error("Invalid parser result or match ID");
  if (!Array.isArray(result.rounds) || !result.rounds.length || result.rounds.length > 2) throw new Error("Parser result requires one or two rounds");
  const seen = new Set();
  for (const r of result.rounds) {
    if (![1, 2].includes(r.round) || seen.has(r.round) || !Number.isFinite(r.durationSeconds) || r.durationSeconds < 0 || !r.teams) throw new Error("Invalid parser round");
    seen.add(r.round);
    for (const team of Object.values(r.teams)) {
      if (!Array.isArray(team.players)) throw new Error("Invalid round players");
      for (const p of team.players) if (!/^STEAM_[0-5]:[01]:\d+$/.test(steam(p))) throw new Error("Invalid player Steam ID");
    }
  }
  if (result.events != null && !Array.isArray(result.events)) throw new Error("Invalid parser events");
}

function importNoNameStats({ result, matchId, sourceUrl = null, db: suppliedDb, dbPath = process.env.DB_PATH || "/root/tfcbot/elo.db" }) {
  validateResult(result, matchId);
  const db = suppliedDb || new Database(dbPath, { fileMustExist: true, timeout: 30000 });
  const id = result.matchId;
  try {
    return db.transaction(() => {
      ensureSchema(db);
      const hasTable = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
      const discordFor = sid => {
        if (!sid) return null;
        if (hasTable("player_steam_ids")) {
          const cols = db.prepare("PRAGMA table_info(player_steam_ids)").all();
          const order = cols.some(c => c.name === "is_primary") ? " ORDER BY is_primary DESC" : "";
          const row = db.prepare(`SELECT discord_id FROM player_steam_ids WHERE steam_id=?${order} LIMIT 1`).get(sid);
          if (row?.discord_id) return row.discord_id;
        }
        if (hasTable("player_identities")) return db.prepare("SELECT discord_id FROM player_identities WHERE steam_id=?").get(sid)?.discord_id || null;
        return null;
      };
      for (const table of Object.keys(schemas)) {
        // Preserve independent TFCStats events; replace old Hampalyzer events so
        // the website never shows both scraped and structured copies.
        db.prepare(`DELETE FROM ${table} WHERE match_id=?${table === "match_flag_events" ? " AND source IN ('noname','hampalyzer')" : ""}`).run(id);
      }
      const roster = new Map();
      for (const [team, players] of Object.entries(result.players || {})) for (const p of players || []) roster.set(steam(p), Number(team));
      // Roster entries in result.players are anchored to original Team A/B.
      // For a missing roster entry, infer from the round's swapped color.
      const originalTeam = (p, round) => roster.get(steam(p)) || ([1, 2].includes(Number(p?.team)) ? (round === 2 ? (Number(p.team) === 1 ? 2 : 1) : Number(p.team)) : null);
      const teamName = (p, round) => ({ 1: "Team A", 2: "Team B" })[originalTeam(p, round)] || null;
      const roleFor = (p, round) => {
        const r = result.rounds.find(r => r.round === round);
        const team = r && Object.values(r.teams).find(t => t.players.some(x => steam(x) === steam(p)));
        return team?.players.find(x => steam(x) === steam(p))?.roles || null;
      };
      const totals = new Map();
      const weapons = new Map();
      const offsets = {}; let offset = 0;
      for (const r of [...result.rounds].sort((a, b) => a.round - b.round)) {
        offsets[r.round] = offset; offset += r.durationSeconds;
        const mappedScores = {}; let offense = null; let defense = null;
        for (const [color, team] of Object.entries(r.teams)) {
          const representative = team.players[0] || { team: Number(color) };
          const original = originalTeam(representative, r.round);
          mappedScores[original] = number(r.score?.[color]);
          if (team.teamStats?.teamRole === 0) offense = teamName(representative, r.round);
          if (team.teamStats?.teamRole === 1) defense = teamName(representative, r.round);
          for (const p of team.players) {
            const sid = steam(p); const base = { match_id: id, player_key: sid, steam_id: sid, display_name: p.name, team: ({ 1: "blue", 2: "red" })[originalTeam(p, r.round)] };
            const stats = Object.fromEntries(Object.entries(ROUND_STATS).map(([k, [group, stat]]) => [k, number(p[group]?.[stat]?.value)]));
            insert(db, "match_player_round_stats", { ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== "team")), round_num: r.round, team_name: teamName(p, r.round), role: roleFor(p, r.round), ...stats, objectives: number(p.objectives?.button?.value) + number(p.objectives?.det_entrance?.value), toss_percent: p.objectives?.toss_percent?.value ?? null });
            const aggregate = totals.get(sid) || { ...base, ...Object.fromEntries(Object.keys(ROUND_STATS).map(k => [k, 0])), classTimes: {} };
            for (const [k, value] of Object.entries(stats)) aggregate[k] += value;
            const classTotals = new Map();
            for (const c of p.classes || []) classTotals.set(c.classAsString, (classTotals.get(c.classAsString) || 0) + number(c.timeInSeconds));
            for (const [className, seconds] of classTotals) {
              insert(db, "match_player_classes", { match_id: id, player_key: sid, class_name: className, round_num: r.round, seconds });
              aggregate.classTimes[className] = (aggregate.classTimes[className] || 0) + seconds;
            }
            totals.set(sid, aggregate);
            if (p.is_mvp) insert(db, "match_round_mvps", { match_id: id, round_num: r.round, mvp_display_name: p.name, mvp_player_key: sid, steam_id: sid });
          }
        }
        insert(db, "match_rounds", { match_id: id, round_num: r.round, map_name: result.map, duration_seconds: r.durationSeconds, team1_score: mappedScores[1] ?? 0, team2_score: mappedScores[2] ?? 0, offense_team: offense, defense_team: defense });
        for (const sg of r.sentry || []) {
          const sid = steam(sg); const base = { match_id: id, player_key: sid, steam_id: sid, display_name: sg.name || totals.get(sid)?.display_name, round_num: r.round, observed_team: sg.team };
          const fields = { engineer_seconds: "engineerSeconds", builds: "builds", upgrades: "upgrades", repairs: "repairs", uptime_seconds: "uptimeSeconds", uptime_percent_round: "uptimePercentRound", uptime_percent_engineer: "uptimePercentEngineer", total_kills: "totalKills", team_kills: "teamKills", destroyed: "destroyed", dismantled: "dismantled", detonated: "detonated", longest_life_seconds: "longestLifeSeconds" };
          insert(db, "match_sentry_round_stats", { ...base, team_name: teamName(sg, r.round), ...Object.fromEntries(Object.entries(fields).map(([key, source]) => [key, sg[source] ?? null])), level_seconds: json(sg.levelSeconds), kills_by_level: json(sg.killsByLevel), warnings: json(sg.warnings || []) });
          (sg.lives || []).forEach((life, index) => insert(db, "match_sentry_lives", { ...base, life_num: index + 1, start_seconds: life.startSeconds, end_seconds: life.endSeconds, end_reason: life.endReason, confidence: life.confidence, level_seconds: json(life.levelSeconds), kills_by_level: json(life.killsByLevel), level_segments: json(life.levelSegments || []) }));
        }
      }
      for (const aggregate of totals.values()) {
        const { classTimes, ...stats } = aggregate;
        insert(db, "match_player_stats", { ...stats, deaths: stats.deaths_by_enemy + stats.deaths_by_team, damage_taken: stats.damage_taken_enemy + stats.damage_taken_team, main_class: Object.entries(classTimes).sort((a, b) => b[1] - a[1])[0]?.[0] || null });
      }
      const capCounts = { blue: 0, red: 0 };
      const flagTypes = { PlayerPickedUpFlag: "pickup", PlayerPickedUpBonusFlag: "pickup", PlayerGainedFlagWithLocation: "pickup", PlayerThrewFlag: "toss", PlayerDroppedFlagViaDeathWithLocation: "drop", PlayerCapturedFlag: "cap", PlayerCapturedBonusFlag: "cap", FlagReturn: "return" };
      for (const e of [...(result.events || [])].sort((a, b) => a.round - b.round || a.timeSeconds - b.timeSeconds)) {
        const r = result.rounds.find(r => r.round === e.round);
        if (!r || !Number.isFinite(e.timeSeconds) || e.timeSeconds < 0 || e.timeSeconds > r.durationSeconds) continue;
        const from = e.playerFrom; const to = e.playerTo; const fromId = steam(from); const toId = steam(to);
        if (e.type === "PlayerFraggedPlayer" && fromId && toId) {
          const enemy = Number(from.team) !== Number(to.team); const weapon = Number.isInteger(e.weaponId) ? `weapon-${e.weaponId}` : "weapon-0";
          insert(db, "match_kill_events", { match_id: id, source_url: sourceUrl, round_num: e.round, event_time_seconds: e.timeSeconds, event_time_text: timeText(e.timeSeconds), attacker_key: fromId, attacker_steam_id: fromId, attacker_discord_id: discordFor(fromId), attacker_name: from.name, attacker_team: teamName(from, e.round), attacker_role: roleFor(from, e.round), attacker_class: from.className, attacker_class_confidence: from.className ? "exact_event" : "unknown", weapon, weapon_name: e.weapon, victim_class: to.className, victim_name: to.name, victim_key: toId, victim_steam_id: toId, victim_discord_id: discordFor(toId), victim_team: teamName(to, e.round), is_enemy_kill: Number(enemy), is_team_kill: Number(!enemy), is_conced: Number(Boolean(e.whileConced)), is_flag_carrier_kill: Number(Boolean(e.playerToWasCarryingFlag)), source_confidence: "exact" });
          if (enemy) { const key = `${fromId}|${weapon}`; weapons.set(key, { match_id: id, player_key: fromId, weapon, weapon_name: e.weapon, kills: (weapons.get(key)?.kills || 0) + 1 }); }
        }
        const flagType = flagTypes[e.type] || (e.type === "PlayerFraggedPlayer" && e.playerToWasCarryingFlag ? "frag" : null);
        if (flagType) {
          const player = flagType === "frag" ? to : from; const other = flagType === "frag" ? from : to;
          const sid = steam(player); const otherId = steam(other);
          const color = ({ 1: "blue", 2: "red" })[originalTeam(player, e.round)] || null;
          insert(db, "match_flag_events", { match_id: id, round_num: e.round, game_time_seconds: e.timeSeconds, event_time_text: timeText(e.timeSeconds), flag_event_type: flagType, subtype: e.type, meta: "none", player_key: sid || null, steam_id: sid || null, display_name: player?.name, team: teamName(player, e.round), class_name: player?.className, conceded: Number(Boolean(e.whileConced)), value: json(e.data), source: "noname", source_url: sourceUrl, other_display_name: other?.name, other_player_key: otherId || null, other_steam_id: otherId || null, source_confidence: "exact" });
          if (flagType === "cap" && color) {
            const seconds = offsets[e.round] + e.timeSeconds;
            insert(db, "match_cap_events", { match_id: id, source_url: sourceUrl, team: color, cap_num: ++capCounts[color], time_seconds: seconds, time_text: timeText(seconds), score_after: null, capper_name: player?.name, capper_steam_id: sid || null, imported_at: Math.floor(Date.now() / 1000) });
          }
        }
      }
      for (const row of weapons.values()) insert(db, "match_player_weapons", row);
      // Preserve every structured upstream stat, including comparisons and
      // flag movement metadata that the legacy website tables do not project.
      insert(db, "match_parser_results", { match_id: id, schema_version: result.schemaVersion, parser_version: result.parserVersion, source_hash: result.sourceHash, parsed_at: result.parsedAt, source_url: sourceUrl, result_json: JSON.stringify(result) });
      insert(db, "match_stat_imports", { match_id: id, source: "noname", source_url: sourceUrl, status: "ok", notes: json({ sourceHash: result.sourceHash, parserVersion: result.parserVersion, players: totals.size }), imported_at: Math.floor(Date.now() / 1000) });
      return { matchId: id, players: totals.size, rounds: result.rounds.length };
    })();
  } finally { if (!suppliedDb) db.close(); }
}

module.exports = { importNoNameStats, ensureSchema, validateResult };
