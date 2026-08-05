#!/usr/bin/env node
"use strict";

/**
 * Permanently merge one Discord account into another.
 *
 * This is an offline administrator maintenance utility. Stop the bot and make
 * a verified SQLite-safe backup before applying a merge. Dry runs execute the
 * same transaction and verification as a real merge, then roll it all back.
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_RATING = 1941;
const DISCORD_ID_RE = /^\d{17,20}$/;

function parseArgs(argv) {
  const options = {
    oldId: null,
    newId: null,
    dryRun: false,
    keepOldRating: false,
    keepNewRating: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = name => token.startsWith(`${name}=`)
      ? token.slice(name.length + 1)
      : argv[++i];

    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--keep-old-rating") options.keepOldRating = true;
    else if (token === "--keep-new-rating") options.keepNewRating = true;
    else if (token === "--old" || token.startsWith("--old=")) options.oldId = value("--old");
    else if (token === "--new" || token.startsWith("--new=")) options.newId = value("--new");
    else throw new Error(`Unknown argument: ${token}`);
  }

  options.oldId = String(options.oldId || "").trim();
  options.newId = String(options.newId || "").trim();
  return options;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function tableName(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function tableExists(db, schema, table) {
  return Boolean(db.prepare(
    `SELECT 1 FROM ${quoteIdentifier(schema)}.sqlite_master WHERE type='table' AND name=?`
  ).get(table));
}

function columnsFor(db, schema, table) {
  if (!tableExists(db, schema, table)) return [];
  return db.prepare(
    `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`
  ).all();
}

function hasColumn(db, schema, table, column) {
  return columnsFor(db, schema, table).some(row => row.name === column);
}

function countWhere(db, schema, table, where, params = []) {
  if (!tableExists(db, schema, table)) return 0;
  return db.prepare(
    `SELECT COUNT(*) AS count FROM ${tableName(schema, table)} WHERE ${where}`
  ).get(...params).count;
}

function getRating(db, id) {
  if (!tableExists(db, "main", "ratings")) return null;
  return db.prepare(
    "SELECT player_id, display_name, rating FROM ratings WHERE player_id=?"
  ).get(id) || null;
}

/** Load the pre-merge account snapshot used for validation and reporting. */
function loadAccounts(db, oldId, newId) {
  const load = id => {
    const rating = getRating(db, id);
    const steamLinks = countWhere(db, "main", "player_steam_ids", "discord_id=?", [id]);
    const identities = countWhere(db, "main", "player_identities", "discord_id=?", [id]);
    const matchPlayers = countWhere(db, "main", "match_players", "player_id=?", [id]);
    const ratingHistory = countWhere(db, "main", "rating_changes", "player_id=?", [id]);
    const discordNames = countWhere(db, "main", "discord_names", "discord_id=?", [id]);
    const jsonMatches = tableExists(db, "main", "matches")
      ? db.prepare(`
          SELECT COUNT(*) AS count FROM matches
          WHERE instr(COALESCE(blue_ids,''), ?) > 0
             OR instr(COALESCE(red_ids,''), ?) > 0
        `).get(id, id).count
      : 0;

    return {
      id,
      rating,
      steamLinks,
      identities,
      matchPlayers,
      ratingHistory,
      discordNames,
      jsonMatches,
      exists: Boolean(
        rating || steamLinks || identities || matchPlayers || ratingHistory ||
        discordNames || jsonMatches
      ),
    };
  };

  return { old: load(oldId), new: load(newId) };
}

/** Validate invocation and the minimum source-account existence guarantee. */
function validate(options, accounts) {
  if (!DISCORD_ID_RE.test(options.oldId)) throw new Error("--old must be a 17-20 digit Discord ID");
  if (!DISCORD_ID_RE.test(options.newId)) throw new Error("--new must be a 17-20 digit Discord ID");
  if (options.oldId === options.newId) throw new Error("--old and --new must be different accounts");
  if (options.keepOldRating && options.keepNewRating) {
    throw new Error("Choose only one of --keep-old-rating or --keep-new-rating");
  }
  if (!accounts.old.exists) throw new Error(`Old account ${options.oldId} does not exist`);
}

/** Apply the documented rating-selection policy without silently discarding Elo. */
function chooseRatingWinner(accounts, options, defaultRating = DEFAULT_RATING) {
  const oldRating = accounts.old.rating;
  const newRating = accounts.new.rating;

  if (!oldRating && !newRating) return null;
  if (options.keepOldRating) {
    if (!oldRating) throw new Error("--keep-old-rating was supplied, but the old account has no rating");
    return "old";
  }
  if (options.keepNewRating) {
    if (!newRating) throw new Error("--keep-new-rating was supplied, but the new account has no rating");
    return "new";
  }
  if (!oldRating) return "new";
  if (!newRating) return "old";

  const oldSeeded = Number(oldRating.rating) === defaultRating;
  const newSeeded = Number(newRating.rating) === defaultRating;
  if (oldSeeded && !newSeeded) return "new";
  if (newSeeded && !oldSeeded) return "old";
  if (!oldSeeded && !newSeeded) {
    throw new Error(
      "Both accounts have non-default ratings. Rerun with --keep-old-rating or --keep-new-rating"
    );
  }
  return "new";
}

function sameValue(a, b) {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return a === b || (a == null && b == null);
}

function uniqueKeysFor(db, schema, table, columns) {
  const keys = [];
  const primaryKey = columns.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name);
  if (primaryKey.length) keys.push(primaryKey);

  const indexes = db.prepare(
    `PRAGMA ${quoteIdentifier(schema)}.index_list(${quoteIdentifier(table)})`
  ).all().filter(index => index.unique);
  for (const index of indexes) {
    const key = db.prepare(
      `PRAGMA ${quoteIdentifier(schema)}.index_info(${quoteIdentifier(index.name)})`
    ).all().sort((a, b) => a.seqno - b.seqno).map(row => row.name).filter(Boolean);
    if (key.length && !keys.some(existing => existing.join("\0") === key.join("\0"))) keys.push(key);
  }
  return { keys, primaryKey };
}

/**
 * Rekey a column while explicitly resolving composite-primary-key conflicts.
 * Identical duplicates are collapsed; differing historical rows abort.
 */
function rekeyWithExplicitConflicts(db, schema, table, column, oldId, newId) {
  const columns = columnsFor(db, schema, table);
  if (!columns.some(row => row.name === column)) return { matched: 0, updated: 0, deduplicated: 0 };

  const qualified = tableName(schema, table);
  const sourceRows = db.prepare(
    `SELECT rowid AS __merge_rowid__, * FROM ${qualified} WHERE ${quoteIdentifier(column)}=?`
  ).all(oldId);
  if (!sourceRows.length) return { matched: 0, updated: 0, deduplicated: 0 };

  const { keys: uniqueKeys, primaryKey } = uniqueKeysFor(db, schema, table, columns);
  let deduplicated = 0;

  if (uniqueKeys.some(key => key.includes(column))) {
    for (const source of sourceRows) {
      let collision = null;
      let collisionKey = null;
      for (const key of uniqueKeys.filter(candidate => candidate.includes(column))) {
        const targetKey = key.map(name => name === column ? newId : source[name]);
        const where = key.map(name => `${quoteIdentifier(name)} IS ?`).join(" AND ");
        const target = db.prepare(`SELECT rowid AS __merge_rowid__, * FROM ${qualified} WHERE ${where}`)
          .get(...targetKey);
        if (target) {
          collision = target;
          collisionKey = key;
          break;
        }
      }
      if (!collision) continue;

      // Ignore the account-ID column and surrogate PKs when comparing rows
      // that collided through a separate UNIQUE index (for example the
      // autoincrement id on rating_changes).
      const surrogatePrimaryKeys = new Set(
        columns.filter(row => row.pk && !collisionKey.includes(row.name)).map(row => row.name)
      );
      const comparable = columns.map(row => row.name).filter(name =>
        name !== column && !surrogatePrimaryKeys.has(name)
      );
      if (!comparable.every(name => sameValue(source[name], collision[name]))) {
        throw new Error(
          `Conflicting ${table} rows would collide on UNIQUE(${collisionKey.join(", ")}); resolve them manually`
        );
      }

      if (primaryKey.length) {
        const where = primaryKey.map(name => `${quoteIdentifier(name)} IS ?`).join(" AND ");
        db.prepare(`DELETE FROM ${qualified} WHERE ${where}`).run(...primaryKey.map(name => source[name]));
      } else {
        db.prepare(`DELETE FROM ${qualified} WHERE rowid=?`).run(source.__merge_rowid__);
      }
      deduplicated += 1;
    }
  }

  const updated = db.prepare(
    `UPDATE ${qualified} SET ${quoteIdentifier(column)}=? WHERE ${quoteIdentifier(column)}=?`
  ).run(newId, oldId).changes;
  return { matched: sourceRows.length, updated, deduplicated };
}

function mergeRatings(db, context) {
  const { oldId, newId, ratingWinner } = context;
  const oldRating = getRating(db, oldId);
  const newRating = getRating(db, newId);
  const report = { ratingWinner, ratingRows: 0, history: 0, historyDeduplicated: 0 };

  if (oldRating) {
    if (newRating) {
      const winner = ratingWinner === "old" ? oldRating : newRating;
      db.prepare("UPDATE ratings SET display_name=?, rating=? WHERE player_id=?")
        .run(winner.display_name, winner.rating, newId);
      db.prepare("DELETE FROM ratings WHERE player_id=?").run(oldId);
    } else {
      db.prepare("UPDATE ratings SET player_id=? WHERE player_id=?").run(newId, oldId);
    }
    report.ratingRows = 1;
  }

  const history = rekeyWithExplicitConflicts(
    db, "main", "rating_changes", "player_id", oldId, newId
  );
  report.history = history.matched;
  report.historyDeduplicated = history.deduplicated;
  return report;
}

function mergeSteamLinks(db, context) {
  const { oldId, newId } = context;
  if (!tableExists(db, "main", "player_steam_ids")) return { matched: 0, deduplicated: 0 };

  const oldRows = db.prepare("SELECT * FROM player_steam_ids WHERE discord_id=?").all(oldId);
  let deduplicated = 0;
  for (const source of oldRows) {
    const target = db.prepare(
      "SELECT * FROM player_steam_ids WHERE discord_id=? AND steam_id=?"
    ).get(newId, source.steam_id);
    if (!target) continue;

    db.prepare(`
      UPDATE player_steam_ids
      SET display_name=?, is_primary=?, notes=?, created_at=?, updated_at=?
      WHERE discord_id=? AND steam_id=?
    `).run(
      target.display_name || source.display_name,
      Math.max(Number(target.is_primary) || 0, Number(source.is_primary) || 0),
      target.notes || source.notes,
      Math.min(Number(target.created_at) || Infinity, Number(source.created_at) || Infinity),
      Math.max(Number(target.updated_at) || 0, Number(source.updated_at) || 0) || null,
      newId,
      source.steam_id
    );
    db.prepare("DELETE FROM player_steam_ids WHERE discord_id=? AND steam_id=?")
      .run(oldId, source.steam_id);
    deduplicated += 1;
  }

  const updated = db.prepare(
    "UPDATE player_steam_ids SET discord_id=? WHERE discord_id=?"
  ).run(newId, oldId).changes;
  return { matched: oldRows.length, updated, deduplicated };
}

function mergeIdentity(db, context) {
  const { oldId, newId } = context;
  const identities = hasColumn(db, "main", "player_identities", "discord_id")
    ? db.prepare("UPDATE player_identities SET discord_id=? WHERE discord_id=?").run(newId, oldId).changes
    : 0;

  let names = 0;
  if (tableExists(db, "main", "discord_names")) {
    const source = db.prepare("SELECT * FROM discord_names WHERE discord_id=?").get(oldId);
    const target = db.prepare("SELECT * FROM discord_names WHERE discord_id=?").get(newId);
    if (source && target) {
      db.prepare(`
        UPDATE discord_names SET username=?, global_name=?, display_name=? WHERE discord_id=?
      `).run(
        target.username || source.username,
        target.global_name || source.global_name,
        target.display_name || source.display_name,
        newId
      );
      db.prepare("DELETE FROM discord_names WHERE discord_id=?").run(oldId);
      names = 1;
    } else if (source) {
      names = db.prepare("UPDATE discord_names SET discord_id=? WHERE discord_id=?")
        .run(newId, oldId).changes;
    }
  }
  return { identities, names };
}

function replaceJsonIdentifier(value, oldId, newId, location) {
  if (value == null || !String(value).includes(oldId)) return { value, changed: false };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${location} contains the old ID but is not valid JSON: ${error.message}`);
  }

  let changed = false;
  const visit = item => {
    if (item === oldId) {
      changed = true;
      return newId;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      const output = {};
      for (const [key, child] of Object.entries(item)) {
        const nextKey = key === oldId ? newId : key;
        if (nextKey !== key) changed = true;
        if (Object.prototype.hasOwnProperty.call(output, nextKey)) {
          throw new Error(`${location} has both old and new Discord IDs as JSON keys`);
        }
        output[nextKey] = visit(child);
      }
      return output;
    }
    return item;
  };

  const output = visit(parsed);
  return { value: changed ? JSON.stringify(output) : value, changed };
}

function mergeMatches(db, context) {
  const { oldId, newId } = context;
  const players = rekeyWithExplicitConflicts(
    db, "main", "match_players", "player_id", oldId, newId
  );
  const jsonColumns = ["blue_ids", "red_ids", "bonus_elo", "shuffle_history", "team_scenarios"]
    .filter(column => hasColumn(db, "main", "matches", column));
  const report = { matchPlayers: players.matched, matchPlayerDeduplicated: players.deduplicated, matches: 0 };
  if (!jsonColumns.length) return report;

  const condition = jsonColumns.map(column => `instr(COALESCE(${quoteIdentifier(column)},''), ?) > 0`).join(" OR ");
  const rows = db.prepare(
    `SELECT match_id, ${jsonColumns.map(quoteIdentifier).join(", ")} FROM matches WHERE ${condition}`
  ).all(...jsonColumns.map(() => oldId));

  for (const row of rows) {
    const values = {};
    let changed = false;
    for (const column of jsonColumns) {
      const replaced = replaceJsonIdentifier(row[column], oldId, newId, `matches.${column} (${row.match_id})`);
      values[column] = replaced.value;
      changed ||= replaced.changed;
    }
    if (!changed) continue;
    db.prepare(
      `UPDATE matches SET ${jsonColumns.map(column => `${quoteIdentifier(column)}=@${column}`).join(", ")} WHERE match_id=@match_id`
    ).run({ ...values, match_id: row.match_id });
    report.matches += 1;
  }
  return report;
}

function mergePrivacyAndMutes(db, context) {
  const { oldId, newId } = context;
  let preferences = 0;
  if (tableExists(db, "main", "user_prefs")) {
    const source = db.prepare("SELECT * FROM user_prefs WHERE player_id=?").get(oldId);
    const target = db.prepare("SELECT * FROM user_prefs WHERE player_id=?").get(newId);
    if (source && target) {
      db.prepare("UPDATE user_prefs SET hide_elo=? WHERE player_id=?")
        .run(Math.max(Number(source.hide_elo) || 0, Number(target.hide_elo) || 0), newId);
      db.prepare("DELETE FROM user_prefs WHERE player_id=?").run(oldId);
      preferences = 1;
    } else if (source) {
      preferences = db.prepare("UPDATE user_prefs SET player_id=? WHERE player_id=?")
        .run(newId, oldId).changes;
    }
  }

  let mutes = 0;
  if (tableExists(db, "main", "pickup_mutes")) {
    const source = db.prepare("SELECT * FROM pickup_mutes WHERE discord_id=?").get(oldId);
    const target = db.prepare("SELECT * FROM pickup_mutes WHERE discord_id=?").get(newId);
    if (source && target) {
      const winner = Number(source.created_at) > Number(target.created_at) ? source : target;
      db.prepare(`
        UPDATE pickup_mutes SET muted_by=?, reason=?, created_at=?, guild_id=? WHERE discord_id=?
      `).run(winner.muted_by, winner.reason, winner.created_at, winner.guild_id, newId);
      db.prepare("DELETE FROM pickup_mutes WHERE discord_id=?").run(oldId);
      mutes = 1;
    } else if (source) {
      mutes = db.prepare("UPDATE pickup_mutes SET discord_id=? WHERE discord_id=?")
        .run(newId, oldId).changes;
    }
    mutes += db.prepare("UPDATE pickup_mutes SET muted_by=? WHERE muted_by=?")
      .run(newId, oldId).changes;
  }
  return { preferences, mutes };
}

function mergeStatistics(db, context) {
  const { oldId, newId } = context;
  const specs = [
    ["match_player_classes", "player_key"],
    ["match_player_round_stats", "player_key"],
    ["match_player_stats", "player_key"],
    ["match_player_weapons", "player_key"],
    ["match_round_mvps", "mvp_player_key"],
    ["match_role_events", "player_key"],
    ["match_flag_events", "player_key"],
    ["match_flag_events", "other_player_key"],
    ["match_engineer_events", "player_key"],
    ["match_damage_summary", "attacker_key"],
    ["match_damage_summary", "victim_key"],
    ["match_kill_events", "attacker_key"],
    ["match_kill_events", "attacker_discord_id"],
    ["match_kill_events", "victim_key"],
    ["match_kill_events", "victim_discord_id"],
    ["one_v_one_challenges", "challenger_discord_id"],
    ["one_v_one_challenges", "challenged_discord_id"],
    ["one_v_one_matches", "challenger_discord_id"],
    ["one_v_one_matches", "challenged_discord_id"],
    ["permap_changes", "player_id"],
    ["permap_ratings", "player_id"],
    ["reset_streaks", "player_id"],
    ["win_streaks", "player_id"],
  ];

  const details = [];
  let matched = 0;
  let deduplicated = 0;
  for (const [table, column] of specs) {
    const result = rekeyWithExplicitConflicts(db, "main", table, column, oldId, newId);
    if (result.matched) details.push({ table, column, ...result });
    matched += result.matched;
    deduplicated += result.deduplicated;
  }
  return { matched, deduplicated, details };
}

function mergeBanTable(db, table, context) {
  const { oldId, newId } = context;
  if (!tableExists(db, "bot", table)) return 0;
  const qualified = tableName("bot", table);
  const source = db.prepare(`SELECT * FROM ${qualified} WHERE user_id=?`).get(oldId);
  const target = db.prepare(`SELECT * FROM ${qualified} WHERE user_id=?`).get(newId);
  if (!source) return 0;

  if (!target) {
    return db.prepare(`UPDATE ${qualified} SET user_id=? WHERE user_id=?`).run(newId, oldId).changes;
  }

  if (table === "game_bans") {
    const latest = Number(source.banned_at) > Number(target.banned_at) ? source : target;
    db.prepare(`
      UPDATE ${qualified}
      SET games_remaining=?, reason=?, banned_at=? WHERE user_id=?
    `).run(
      Math.max(Number(source.games_remaining) || 0, Number(target.games_remaining) || 0),
      latest.reason,
      Math.max(Number(source.banned_at) || 0, Number(target.banned_at) || 0),
      newId
    );
  } else {
    db.prepare(`UPDATE ${qualified} SET expires_at=? WHERE user_id=?`)
      .run(Math.max(Number(source.expires_at) || 0, Number(target.expires_at) || 0), newId);
  }
  db.prepare(`DELETE FROM ${qualified} WHERE user_id=?`).run(oldId);
  return 1;
}

function mergeBotDatabase(db, context) {
  return {
    gameBans: mergeBanTable(db, "game_bans", context),
    tempBans: mergeBanTable(db, "temp_bans", context),
  };
}

function isExpectedRemainingReference(reference, oldId) {
  if (reference.schema === "main" && reference.table === "web_analytics") return true;
  if (
    reference.schema === "main" &&
    reference.table === "rating_changes" &&
    reference.column === "match_id" &&
    String(reference.value).includes(`seed-${oldId}`)
  ) return true;
  return false;
}

/** Scan each table once and classify every remaining textual old-ID reference. */
function verify(db, oldId) {
  const references = [];
  for (const schema of ["main", "bot"]) {
    const tables = db.prepare(`
      SELECT name FROM ${quoteIdentifier(schema)}.sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all();

    for (const { name: table } of tables) {
      const columns = columnsFor(db, schema, table).filter(column => !/BLOB/i.test(column.type || ""));
      if (!columns.length) continue;
      const predicates = columns.map(column =>
        `instr(CAST(${quoteIdentifier(column.name)} AS TEXT), ?) > 0`
      );
      const selected = columns.map(column => quoteIdentifier(column.name)).join(", ");
      const rows = db.prepare(`
        SELECT ${selected} FROM ${tableName(schema, table)}
        WHERE ${predicates.join(" OR ")}
      `).all(...columns.map(() => oldId));

      for (const row of rows) {
        for (const column of columns) {
          const value = row[column.name];
          if (value == null || !String(value).includes(oldId)) continue;
          const reference = { schema, table, column: column.name, value };
          reference.expected = isExpectedRemainingReference(reference, oldId);
          references.push(reference);
        }
      }
    }
  }
  return {
    expected: references.filter(reference => reference.expected),
    unexpected: references.filter(reference => !reference.expected),
  };
}

function printAccount(label, account) {
  console.log(`${label}: ${account.id}`);
  console.log(`  exists: ${account.exists ? "yes" : "no"}`);
  console.log(`  rating: ${account.rating ? `${account.rating.rating} (${account.rating.display_name || "unnamed"})` : "none"}`);
  console.log(`  steam links: ${account.steamLinks}`);
  console.log(`  player identities: ${account.identities}`);
  console.log(`  match players: ${account.matchPlayers}`);
  console.log(`  matches containing ID: ${account.jsonMatches}`);
  console.log(`  rating history: ${account.ratingHistory}`);
}

function printSummary(accounts, options, ratingWinner, report = null, verification = null) {
  console.log("-----------------------------------------");
  console.log(options.dryRun ? "Discord Account Merge — Dry Run" : "Discord Account Merge");
  console.log("-----------------------------------------");
  printAccount("Old", accounts.old);
  printAccount("New", accounts.new);
  console.log(`Rating selection: ${ratingWinner || "no rating row"}`);

  if (!report) return;
  console.log("-----------------------------------------");
  console.log(options.dryRun ? "Discord Merge Dry Run Complete" : "Discord Merge Complete");
  console.log(`Ratings merged: ${report.ratings.ratingRows}`);
  console.log(`Rating history updated: ${report.ratings.history}`);
  console.log(`Match players updated: ${report.matches.matchPlayers}`);
  console.log(`Matches updated: ${report.matches.matches}`);
  console.log(`Steam links updated: ${report.steam.matched}`);
  console.log(`Player identities updated: ${report.identity.identities}`);
  console.log(`Statistics updated: ${report.statistics.matched}`);
  console.log(`bot.db updated: ${report.bot.gameBans + report.bot.tempBans}`);
  console.log("Remaining references:");
  if (!verification.expected.length && !verification.unexpected.length) console.log("  none");
  for (const item of verification.expected) {
    console.log(`  ${item.schema}.${item.table}.${item.column}: ${item.value} (expected)`);
  }
  for (const item of verification.unexpected) {
    console.log(`  ${item.schema}.${item.table}.${item.column}: ${item.value} (UNEXPECTED)`);
  }
  if (!verification.unexpected.length) console.log("No unexpected references found.");
}

function runMerge(options, paths = {}) {
  const eloPath = path.resolve(paths.eloPath || process.env.ELO_DB_PATH || "elo.db");
  const botPath = path.resolve(paths.botPath || process.env.BOT_DB_PATH || "bot.db");
  if (!fs.existsSync(eloPath)) throw new Error(`elo.db not found: ${eloPath}`);
  if (!fs.existsSync(botPath)) throw new Error(`bot.db not found: ${botPath}`);

  const db = new Database(eloPath);
  let transactionOpen = false;
  try {
    db.prepare("ATTACH DATABASE ? AS bot").run(botPath);
    const accounts = loadAccounts(db, options.oldId, options.newId);
    validate(options, accounts);
    const ratingWinner = chooseRatingWinner(accounts, options);
    printSummary(accounts, options, ratingWinner);

    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const context = { ...options, ratingWinner };
    const report = {
      ratings: mergeRatings(db, context),
      steam: mergeSteamLinks(db, context),
      identity: mergeIdentity(db, context),
      matches: mergeMatches(db, context),
      statistics: mergeStatistics(db, context),
      privacy: mergePrivacyAndMutes(db, context),
      bot: mergeBotDatabase(db, context),
    };
    const verification = verify(db, options.oldId);
    printSummary(accounts, options, ratingWinner, report, verification);

    if (verification.unexpected.length) {
      throw new Error(`${verification.unexpected.length} unexpected old-ID reference(s) remain`);
    }
    if (options.dryRun) db.exec("ROLLBACK");
    else db.exec("COMMIT");
    transactionOpen = false;
    return { accounts, ratingWinner, report, verification };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    throw error;
  } finally {
    try { db.close(); } catch {}
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    runMerge(options);
  } catch (error) {
    console.error(`[mergeDiscordAccount] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_RATING,
  chooseRatingWinner,
  loadAccounts,
  mergeBotDatabase,
  mergeIdentity,
  mergeMatches,
  mergeRatings,
  mergeStatistics,
  mergeSteamLinks,
  parseArgs,
  printSummary,
  runMerge,
  validate,
  verify,
};
