// services/bootcampWatcher.js
"use strict";

// Noname TFC Bootcamp feed.
//
// The Bootcamp plugin writes tier-ups, records, PBs and lesson completions to
// bootcamp_events in the shared MariaDB. This watcher reads that feed, then:
//   - recomputes the player's TFC license (lib/bootcampLicense.js) and stores
//     it in bootcamp_licenses, emitting a "license" event when it rises
//   - syncs the license roles of every Discord member linked to that Steam ID
//   - posts records, tier-ups and new licenses to the Bootcamp channel

const {
  computeLicense,
  bestLicense,
  levelRank,
  parseEndorsements,
  formatLevel,
  formatEndorsement,
  CLASS_IDS,
} = require("../lib/bootcampLicense");

const DEFAULT_POLL_MS = 20_000;
const LAST_EVENT_KEY = "bootcamp:last_event_id";
const TIER_NAMES = ["None", "Bronze", "Silver", "Gold", "Platinum"];
const TIER_EMOJI = ["", "🥉", "🥈", "🥇", "💎"];

let interval = null;
let running = false;

function baseUrl() {
  return (process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/$/, "");
}

function formatTime(ms) {
  const total = Number(ms || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/* ---------------------------------------------------------------------------
   Role configuration
   --------------------------------------------------------------------------- */

// Discord role ids for each license level and endorsement. Offense reuses
// the queue's existing OFFENSE_ROLE_ID so !addoff gating works unchanged.
function licenseRoleIds(config = {}) {
  const env = process.env;
  const roles = {
    permit: env.BOOTCAMP_PERMIT_ROLE_ID || "",
    licensed: env.BOOTCAMP_LICENSED_ROLE_ID || "",
    platinum: env.BOOTCAMP_PLATINUM_ROLE_ID || "",
    offense: config?.roles?.offense || env.OFFENSE_ROLE_ID || "",
  };
  for (const name of Object.keys(CLASS_IDS)) {
    const id = env[`BOOTCAMP_${name.toUpperCase()}_ROLE_ID`];
    if (id) roles[`class:${name}`] = id;
  }
  return roles;
}

// Roles a license should carry. Higher levels also carry lower level roles,
// so "Licensed" stays on a platinum player and the queue gate keeps working.
function rolesForLicense(license, roleIds) {
  const wanted = new Set();
  const rank = levelRank(license?.level || "none");
  if (rank >= 1 && roleIds.permit) wanted.add(roleIds.permit);
  if (rank >= 2 && roleIds.licensed) wanted.add(roleIds.licensed);
  if (rank >= 3 && roleIds.platinum) wanted.add(roleIds.platinum);
  for (const e of license?.endorsements || [])
    if (roleIds[e]) wanted.add(roleIds[e]);
  return wanted;
}

/* ---------------------------------------------------------------------------
   License computation from the database
   --------------------------------------------------------------------------- */
async function loadCatalogue(pool) {
  const [[drills], [routes], [rotation]] = await Promise.all([
    pool.query("SELECT id, map, slug, kind, class_id FROM bootcamp_drills WHERE enabled = 1"),
    pool.query("SELECT id, map, slug, type, class_id FROM bootcamp_routes WHERE enabled = 1"),
    pool.query("SELECT map, rotation_order FROM bootcamp_maps WHERE in_rotation = 1"),
  ]);
  return { drills, routes, rotation };
}

function licenseRules() {
  try {
    return JSON.parse(process.env.BOOTCAMP_LICENSE_RULES || "{}");
  } catch {
    return {};
  }
}

async function recomputeLicense(pool, steamid, catalogue) {
  const [tiers] = await pool.query(
    "SELECT target_type, target_id, class_id, tier FROM bootcamp_tiers WHERE steamid = ?",
    [steamid]
  );
  const [prevRows] = await pool.query(
    "SELECT level, endorsements FROM bootcamp_licenses WHERE steamid = ?",
    [steamid]
  );
  const previous = prevRows[0]
    ? { level: prevRows[0].level, endorsements: parseEndorsements(prevRows[0].endorsements) }
    : { level: "none", endorsements: [] };

  const next = computeLicense({ ...catalogue, tiers, previous, rules: licenseRules() });
  const changed =
    next.level !== previous.level ||
    next.endorsements.join(",") !== previous.endorsements.join(",");

  if (changed) {
    await pool.query(
      `INSERT INTO bootcamp_licenses (steamid, level, endorsements, granted_at)
       VALUES (?, ?, ?, IF(? = 'none', NULL, NOW()))
       ON DUPLICATE KEY UPDATE
         granted_at = IF(VALUES(level) <> level, NOW(), granted_at),
         level = VALUES(level),
         endorsements = VALUES(endorsements)`,
      [steamid, next.level, next.endorsements.join(","), next.level]
    );
  }
  return { previous, next, changed };
}

/* ---------------------------------------------------------------------------
   Discord
   --------------------------------------------------------------------------- */
async function findBootcampChannel(client) {
  const id = process.env.BOOTCAMP_CHANNEL_ID;
  if (id) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel) return channel;
  }
  const name = process.env.BOOTCAMP_CHANNEL_NAME || "bootcamp";
  return client.channels.cache.find(ch => ch.name === name) || null;
}

// Best license across every Steam ID a Discord member has linked.
async function licenseForDiscord(pool, steamLinks, discordId) {
  const links = (await steamLinks.getSteamIds(discordId).catch(() => [])) || [];
  const steamIds = links.map(l => l.steam_id).filter(Boolean);
  if (!steamIds.length) return { level: "none", endorsements: [] };
  const [rows] = await pool.query(
    `SELECT level, endorsements FROM bootcamp_licenses WHERE steamid IN (${steamIds.map(() => "?").join(",")})`,
    steamIds
  );
  let best = { level: "none", endorsements: [] };
  for (const row of rows)
    best = bestLicense(best, { level: row.level, endorsements: parseEndorsements(row.endorsements) });
  return best;
}

async function syncMemberRoles({ client, pool, steamLinks, config, logger }, discordId) {
  const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
  const guilds = guildId
    ? [await client.guilds.fetch(guildId).catch(() => null)].filter(Boolean)
    : [...client.guilds.cache.values()];
  const roleIds = licenseRoleIds(config);
  const managed = new Set(Object.values(roleIds).filter(Boolean));
  if (!managed.size)
    return;

  const license = await licenseForDiscord(pool, steamLinks, discordId);
  const wanted = rolesForLicense(license, roleIds);

  for (const guild of guilds) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) continue;
    for (const roleId of managed) {
      const has = member.roles.cache.has(roleId);
      // The offense role may be granted by hand too; Bootcamp only adds it.
      if (wanted.has(roleId) && !has)
        await member.roles.add(roleId, "Bootcamp license").catch(e => logger.warn?.(`[bootcamp] add role ${roleId}: ${e.message}`));
      else if (!wanted.has(roleId) && has && roleId !== roleIds.offense)
        await member.roles.remove(roleId, "Bootcamp license").catch(e => logger.warn?.(`[bootcamp] remove role ${roleId}: ${e.message}`));
    }
  }
}

async function targetName(pool, type, id) {
  const table = type === "route" ? "bootcamp_routes" : "bootcamp_drills";
  const [rows] = await pool.query(`SELECT name, map FROM ${table} WHERE id = ?`, [id]).catch(() => [[]]);
  return rows[0] ? `${rows[0].name} (${rows[0].map})` : `${type} ${id}`;
}

function playerUrl(steamid) {
  return `${baseUrl()}/bootcamp-player.html?id=${encodeURIComponent(steamid)}`;
}

async function postEvent(channel, pool, event) {
  if (!channel) return;
  const name = event.player_name || event.steamid;
  const player = `[${name}](${playerUrl(event.steamid)})`;

  if (event.kind === "record") {
    const [runs] = await pool.query(
      "SELECT id FROM bootcamp_runs WHERE route_id = ? AND steamid = ? AND time_ms = ? ORDER BY id DESC LIMIT 1",
      [event.target_id, event.steamid, event.value_ms]
    ).catch(() => [[]]);
    const replay = runs[0] ? `\n[View replay](${baseUrl()}/speedrun-replay.html?bootcampRunId=${runs[0].id})` : "";
    const { EmbedBuilder } = require("discord.js");
    const embed = new EmbedBuilder()
      .setColor(0xffc83d)
      .setTitle("🏁 New Bootcamp route record")
      .setDescription(`${player} set the record on **${await targetName(pool, "route", event.target_id)}**: **${formatTime(event.value_ms)}**${replay}`)
      .setTimestamp(new Date(event.created_at || Date.now()));
    await channel.send({ embeds: [embed] }).catch(() => {});
  } else if (event.kind === "tier_up" && Number(event.tier) >= 3) {
    // Bronze and silver are frequent; only gold and platinum are announced.
    const tier = Number(event.tier);
    await channel.send(
      `${TIER_EMOJI[tier]} ${player} reached **${TIER_NAMES[tier]}** on ${await targetName(pool, event.target_type, event.target_id)}`
    ).catch(() => {});
  }
}

async function postLicense(channel, steamid, name, next) {
  if (!channel) return;
  const parts = [`🎓 [${name || steamid}](${playerUrl(steamid)}) earned the **${formatLevel(next.level)}**`];
  if (next.endorsements.length)
    parts.push(`Endorsements: ${next.endorsements.map(formatEndorsement).join(", ")}`);
  await channel.send(parts.join("\n")).catch(() => {});
}

/* ---------------------------------------------------------------------------
   Poll
   --------------------------------------------------------------------------- */
async function pollBootcampEvents(ctx) {
  if (running) return;
  running = true;
  const { client, pool, settings, steamLinks, logger = console } = ctx;
  try {
    let lastId = Number(settings?.getNumber?.(LAST_EVENT_KEY, 0) || 0);
    if (!lastId) {
      // First start: begin at the end of the feed instead of replaying history.
      const [[row]] = await pool.query("SELECT COALESCE(MAX(id), 0) AS id FROM bootcamp_events");
      lastId = Number(row?.id || 0);
      settings?.setNumber?.(LAST_EVENT_KEY, lastId);
      return;
    }

    const [events] = await pool.query(
      "SELECT * FROM bootcamp_events WHERE id > ? ORDER BY id ASC LIMIT 200",
      [lastId]
    );
    if (!events.length) return;

    const channel = await findBootcampChannel(client);
    const catalogue = await loadCatalogue(pool);
    const touched = new Map();   // steamid -> player name

    for (const event of events) {
      if (event.kind === "license") continue;
      await postEvent(channel, pool, event);
      if (event.kind === "tier_up" || event.kind === "lesson" || event.kind === "record")
        touched.set(event.steamid, event.player_name);
      lastId = Math.max(lastId, Number(event.id));
    }

    for (const [steamid, name] of touched) {
      const { previous, next, changed } = await recomputeLicense(pool, steamid, catalogue);
      if (!changed) continue;
      const rose = levelRank(next.level) > levelRank(previous.level) ||
        next.endorsements.some(e => !previous.endorsements.includes(e));
      if (rose) {
        await pool.query(
          "INSERT INTO bootcamp_events (kind, steamid, player_name, target_type) VALUES ('license', ?, ?, ?)",
          [steamid, name || "", next.level]
        ).catch(() => {});
        await postLicense(channel, steamid, name, next);
      }
      const linked = (await steamLinks?.getDiscordBySteam?.(steamid).catch(() => [])) || [];
      for (const link of linked)
        await syncMemberRoles(ctx, link.discord_id).catch(e => logger.warn?.(`[bootcamp] role sync: ${e.message}`));
    }

    settings?.setNumber?.(LAST_EVENT_KEY, lastId);
  } catch (err) {
    logger.error?.(`[bootcampWatcher] poll failed: ${err.message}`);
  } finally {
    running = false;
  }
}

async function startBootcampWatcher({ client, pool, config = {}, settings, steamLinks, logger = console }) {
  if (String(process.env.BOOTCAMP_WATCHER_ENABLED ?? "true").toLowerCase() === "false") {
    logger.info?.("[bootcampWatcher] disabled");
    return;
  }
  if (!client || !pool) {
    logger.warn?.("[bootcampWatcher] missing client or pool");
    return;
  }
  // The plugin creates the tables; without them there is nothing to watch.
  try {
    await pool.query("SELECT 1 FROM bootcamp_events LIMIT 1");
  } catch (err) {
    logger.info?.(`[bootcampWatcher] bootcamp_events not available (${err.code || err.message}); not started`);
    return;
  }

  const pollMs = Number(process.env.BOOTCAMP_WATCHER_POLL_MS || DEFAULT_POLL_MS);
  const ctx = { client, pool, config, settings, steamLinks, logger };
  logger.info?.(`[bootcampWatcher] starting, poll=${pollMs}ms`);
  await pollBootcampEvents(ctx);
  interval = setInterval(() => pollBootcampEvents(ctx), pollMs);
}

function stopBootcampWatcher() {
  if (interval) clearInterval(interval);
  interval = null;
}

module.exports = {
  startBootcampWatcher,
  stopBootcampWatcher,
  pollBootcampEvents,
  recomputeLicense,
  licenseForDiscord,
  syncMemberRoles,
  licenseRoleIds,
  rolesForLicense,
  formatTime,
};
