"use strict";

/*
  importTfcstatsCaps.js

  Purpose:
    Enrich existing Hampalyzer cap timeline rows with capper_name + capper_steam_id.

  Important:
    - This script DOES NOT import full TFCStats events.
    - This script DOES NOT create match_tfcstats_events.
    - This script DOES NOT create tfcstats_imports.
    - This script DOES NOT replace team/cap_num/time data.
    - Hampalyzer's match_cap_events table remains the source of truth for:
        team, cap_num, time_seconds, time_text, score_after
    - TFCStats is used ONLY to find who capped at that timestamp.

  Usage:
    node importTfcstatsCaps.js MATCH_ID [TFCSTATS_URL_OR_SLUG] [--dry-run] [--force]

  Examples:
    node importTfcstatsCaps.js 229EAY --dry-run
    node importTfcstatsCaps.js 229EAY --force
    node importTfcstatsCaps.js 229EAY "https://www.tfcstats.com/pickup/fun-stuff-east-raiden9-jun-20-2026" --dry-run
*/

const https = require("https");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.TFCBOT_DB_PATH || "/root/tfcbot/elo.db";
const API_BASE = "https://www.tfcstats.com/api/";

const args = process.argv.slice(2);
const matchId = args[0];
const flags = new Set(args.filter(a => String(a).startsWith("--")));
const input = args.slice(1).find(a => !String(a).startsWith("--")) || null;

const FORCE = flags.has("--force");
const DRY_RUN = flags.has("--dry-run");

if (!matchId) {
  console.error("Usage: node importTfcstatsCaps.js MATCH_ID [TFCSTATS_URL_OR_SLUG] [--force] [--dry-run]");
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);
db.configure("busyTimeout", 30000);

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        let data = "";
        res.on("data", c => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}: ${data.slice(0, 300)}`));
            return;
          }
          resolve(data);
        });
      })
      .on("error", reject);
  });
}

async function getJson(url) {
  const raw = await get(url);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err.message}\n${raw.slice(0, 500)}`);
  }
}

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    });
  });
}

function getDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function extractSlug(value) {
  const s = String(value || "").trim();
  const m = s.match(/\/pickup\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return s
    .replace(/^https?:\/\/www\.tfcstats\.com\/?/i, "")
    .replace(/^pickup\//i, "")
    .replace(/[/?#].*$/, "");
}

function steamToPlayerKey(steamid) {
  if (!steamid) return null;
  return steamid.startsWith("STEAM_") ? steamid : `STEAM_${steamid}`;
}

function formatTime(seconds) {
  const n = Number(seconds || 0);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

async function ensureSchema() {
  await runDb(`
    CREATE TABLE IF NOT EXISTS match_cap_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      source_url TEXT,
      team TEXT NOT NULL,
      cap_num INTEGER NOT NULL,
      time_seconds INTEGER NOT NULL,
      time_text TEXT NOT NULL,
      score_after INTEGER,
      imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      capper_name TEXT,
      capper_steam_id TEXT,
      UNIQUE(match_id, team, cap_num)
    )
  `);

  const cols = await allDb(`PRAGMA table_info(match_cap_events)`);
  const names = new Set(cols.map(c => c.name));

  if (!names.has("capper_name")) {
    await runDb(`ALTER TABLE match_cap_events ADD COLUMN capper_name TEXT`);
  }

  if (!names.has("capper_steam_id")) {
    await runDb(`ALTER TABLE match_cap_events ADD COLUMN capper_steam_id TEXT`);
  }

  await runDb(`CREATE INDEX IF NOT EXISTS idx_match_cap_events_match ON match_cap_events(match_id)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_match_cap_events_time ON match_cap_events(match_id, time_seconds)`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_match_cap_events_capper ON match_cap_events(capper_steam_id)`);
}

async function getSlugForMatch() {
  if (input) return extractSlug(input);

  const row = await getDb(
    `SELECT tfcstats_url FROM matches WHERE match_id = ?`,
    [matchId]
  );

  if (!row || !row.tfcstats_url || !String(row.tfcstats_url).trim()) {
    throw new Error(`No tfcstats_url found for match_id=${matchId}. Pass URL/slug as second argument.`);
  }

  return extractSlug(row.tfcstats_url);
}

function buildPlayerLookup(players) {
  const byPlayerId = {};
  for (const p of players || []) {
    if (p.playerId != null && !byPlayerId[p.playerId]) byPlayerId[p.playerId] = p;
  }
  return byPlayerId;
}

async function main() {
  await ensureSchema();

  const slug = await getSlugForMatch();

  const hampCaps = await allDb(
    `SELECT id, match_id, team, cap_num, time_seconds, time_text, score_after, capper_name, capper_steam_id
     FROM match_cap_events
     WHERE match_id = ?
     ORDER BY time_seconds, id`,
    [matchId]
  );

  if (!hampCaps.length) {
    throw new Error(`No Hampalyzer cap rows found in match_cap_events for match_id=${matchId}. Run hampalyzerImport.js first.`);
  }

  const pickupJson = await getJson(`${API_BASE}pickup/${encodeURIComponent(slug)}`);
  if (!pickupJson || !pickupJson.pickup || !pickupJson.pickup.pickupId) {
    throw new Error(`No pickup found for slug: ${slug}`);
  }

  const pickupId = pickupJson.pickup.pickupId;
  const byPlayerId = buildPlayerLookup(pickupJson.players || []);

  const eventsJson = await getJson(`${API_BASE}pickup-events/${pickupId}`);
  const tfcCaps = (eventsJson.events || [])
    .filter(ev => ev.type === "player_captured_flag" || ev.type === "player_captured_bonus_flag")
    .sort((a, b) =>
      Number(a.gameTime || 0) - Number(b.gameTime || 0) ||
      Number(a.roundNum || 0) - Number(b.roundNum || 0)
    );

  const mismatches = [];
  const updates = [];

  if (hampCaps.length !== tfcCaps.length) {
    mismatches.push(`cap count mismatch: hamp=${hampCaps.length} tfc=${tfcCaps.length}`);
  }

  const count = Math.min(hampCaps.length, tfcCaps.length);

  for (let i = 0; i < count; i++) {
    const hamp = hampCaps[i];
    const tfc = tfcCaps[i];

    if (Number(hamp.time_seconds) !== Number(tfc.gameTime)) {
      mismatches.push(
        `cap #${i + 1} time mismatch: hamp=${hamp.time_text}/${hamp.time_seconds}s ${hamp.team} cap=${hamp.cap_num} | tfc=R${tfc.roundNum} ${formatTime(tfc.gameTime)}/${tfc.gameTime}s playerFromId=${tfc.playerFromId}`
      );
      continue;
    }

    const player = byPlayerId[tfc.playerFromId] || {};
    updates.push({
      id: hamp.id,

      // KEEP THESE FROM HAMPALYZER ONLY.
      team: hamp.team,
      cap_num: hamp.cap_num,
      time_text: hamp.time_text,
      time_seconds: hamp.time_seconds,

      // TFCSTATS ONLY PROVIDES WHO CAPPED.
      capperName: player.playerName || String(tfc.playerFromId || ""),
      capperSteam: steamToPlayerKey(player.steamid),
    });
  }

  console.log(`[tfcstats-caps] match=${matchId} slug=${slug} pickup_id=${pickupId}`);
  console.log(`[tfcstats-caps] hamp_caps=${hampCaps.length} tfc_caps=${tfcCaps.length} exact=${updates.length} mismatches=${mismatches.length}`);

  if (mismatches.length) {
    console.log("[tfcstats-caps] SKIP: timeline mismatch, no DB writes");
    for (const msg of mismatches) console.log(`  ${msg}`);
    db.close();
    process.exit(2);
  }

  for (const u of updates) {
    console.log(`  ${String(u.team).toUpperCase()} Cap ${u.cap_num} ${u.time_text} -> ${u.capperName} ${u.capperSteam || ""}`);
  }

  if (DRY_RUN) {
    console.log("[tfcstats-caps] dry-run only; no DB updates written");
    db.close();
    return;
  }

  await runDb("BEGIN");

  let written = 0;

  for (const u of updates) {
    if (!FORCE) {
      const existing = await getDb(
        `SELECT capper_name, capper_steam_id FROM match_cap_events WHERE id = ?`,
        [u.id]
      );

      if (existing && (existing.capper_name || existing.capper_steam_id)) {
        continue;
      }
    }

    await runDb(
      `UPDATE match_cap_events
       SET capper_name = ?,
           capper_steam_id = ?
       WHERE id = ?`,
      [u.capperName, u.capperSteam, u.id]
    );
    written++;
  }

  await runDb("COMMIT");

  console.log(`[tfcstats-caps] updated=${written}`);
  db.close();
}

main().catch(async err => {
  console.error(err);
  try { await runDb("ROLLBACK"); } catch {}
  db.close();
  process.exit(1);
});
