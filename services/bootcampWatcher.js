// services/bootcampWatcher.js
"use strict";

// Noname TFC Bootcamp feed.
//
// The website is the Bootcamp data boundary. This watcher consumes its
// authenticated event and license APIs, then syncs linked Discord roles and
// posts records, tier-ups, lessons and licenses to the Bootcamp channel.

const {
  bestLicense,
  levelRank,
  formatLevel,
  formatEndorsement,
  CLASS_IDS,
} = require("../lib/bootcampLicense");

const DEFAULT_POLL_MS = 20_000;
const LAST_EVENT_KEY = "bootcamp:last_event_id";
const LAST_CHALLENGE_KEY = "bootcamp:last_challenge_id";
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
    queueRequired: config?.roles?.queueRequired || env.BOOTCAMP_QUEUE_REQUIRED_ROLE_ID || env.BOOTCAMP_LICENSED_ROLE_ID || "",
    offense: config?.roles?.offense || env.OFFENSE_ROLE_ID || "",
    bootcampOffense: config?.roles?.bootcampOffense || env.BOOTCAMP_OFFENSE_ROLE_ID || "",
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
  if (rank >= 2 && roleIds.queueRequired) wanted.add(roleIds.queueRequired);
  if (rank >= 3 && roleIds.platinum) wanted.add(roleIds.platinum);
  for (const e of license?.endorsements || [])
    if (roleIds[e]) wanted.add(roleIds[e]);
  if ((license?.endorsements || []).includes("offense") && roleIds.bootcampOffense)
    wanted.add(roleIds.bootcampOffense);
  return wanted;
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

async function announceWeeklyChallenge({ client, api, settings, logger = console }) {
  if (String(process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED || "").trim().toLowerCase() !== "true")
    return false;
  const { challenge } = await api.challenge();
  if (!challenge) return false;
  const id = Number(challenge.id);
  if (Number(settings?.getNumber?.(LAST_CHALLENGE_KEY, -1)) === id) return true;
  const channel = await findBootcampChannel(client);
  if (!channel) {
    logger.warn?.("[bootcampWatcher] weekly challenge has no notification channel; announcement will retry");
    return false;
  }
  await channel.send(`🏆 This week's TFC Bootcamp challenge: **${challenge.title}** — ${challenge.targetName} on **${challenge.map}**. Use !challenge to see standings.`);
  settings?.setNumber?.(LAST_CHALLENGE_KEY, id);
  return true;
}

// Best license across every Steam ID a Discord member has linked.
async function licenseForDiscord(api, steamLinks, discordId, linkedRows = null) {
  // Failure to read identities must not be interpreted as a player unlinking.
  const links = linkedRows || (await steamLinks.getSteamIds(discordId)) || [];
  const steamIds = links.map(l => l.steam_id).filter(Boolean);
  if (!steamIds.length) return { level: "none", endorsements: [] };
  const rows = (await Promise.all(steamIds.map(async steamId => (await api.player(steamId)).license))).filter(Boolean);
  let best = { level: "none", endorsements: [] };
  for (const row of rows)
    best = bestLicense(best, row);
  return best;
}

async function syncMemberRoles({ client, api, steamLinks, config, logger }, discordId) {
  const guildId = process.env.GUILD_ID || process.env.DISCORD_GUILD_ID;
  const guilds = guildId
    ? [await client.guilds.fetch(guildId)]
    : [...client.guilds.cache.values()];
  const roleIds = licenseRoleIds(config);
  const managed = new Set(Object.values(roleIds).filter(Boolean));
  if (!managed.size)
    return;

  const license = await licenseForDiscord(api, steamLinks, discordId);
  const wanted = rolesForLicense(license, roleIds);

  for (const guild of guilds) {
    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch (error) {
      // Discord's Unknown Member means the user is not in this guild; other
      // failures must be retried rather than advancing the event cursor.
      if (Number(error.code) === 10007) continue;
      throw error;
    }
    if (!member) throw new Error("Discord member lookup returned no member");
    for (const roleId of managed) {
      const has = member.roles.cache.has(roleId);
      // The offense role may be granted by hand too; Bootcamp only adds it.
      if (wanted.has(roleId) && !has)
        await member.roles.add(roleId, "Bootcamp license");
      else if (!wanted.has(roleId) && has && roleId !== roleIds.offense)
        await member.roles.remove(roleId, "Bootcamp license");
    }
  }
}

function playerUrl(steamid) {
  return `${baseUrl()}/bootcamp.html?steamid=${encodeURIComponent(steamid)}`;
}

async function postEvent(channel, api, event) {
  if (!channel) return !["record", "pb", "tier_up", "lesson", "license"].includes(event.kind);
  const steamId = event.steamId || event.steamid;
  const name = event.playerName || event.player_name || steamId;
  const player = `[${name}](${playerUrl(steamId)})`;
  const targetName = event.targetName || `${event.targetType || event.target_type || "training"} ${event.targetId ?? event.target_id ?? ""}`;

  if (event.kind === "record") {
    const replay = event.replayRunId ? `\n[View replay](${baseUrl()}/speedrun-replay.html?source=bootcamp&runId=${encodeURIComponent(event.replayRunId)})` : "";
    const { EmbedBuilder } = require("discord.js");
    const embed = new EmbedBuilder()
      .setColor(0xffc83d)
      .setTitle("🏁 New Bootcamp route record")
      .setDescription(`${player} set the record on **${targetName}**: **${formatTime(event.valueMs ?? event.value_ms)}**${replay}`)
      .setTimestamp(new Date(event.createdAt || event.created_at || Date.now()));
    await channel.send({ embeds: [embed] });
  } else if (event.kind === "pb") {
    await channel.send(`${player} set a personal best on **${targetName}**: **${formatTime(event.valueMs ?? event.value_ms)}**`);
  } else if (event.kind === "tier_up" && Number(event.tier) >= 1 && Number(event.tier) <= 4) {
    const tier = Number(event.tier);
    await channel.send(
      `${TIER_EMOJI[tier]} ${player} reached **${TIER_NAMES[tier]}** on ${targetName}`
    );
  } else if (event.kind === "lesson") {
    await channel.send(`📘 ${player} completed a Bootcamp lesson on **${event.map || "a training map"}**.`);
  } else if (event.kind === "license") {
    const profile = await api.player(steamId);
    if (profile.license) await postLicense(channel, steamId, name, profile.license);
  }
  return true;
}

async function postLicense(channel, steamid, name, next) {
  if (!channel) return;
  const parts = [`🎓 [${name || steamid}](${playerUrl(steamid)}) earned the **${formatLevel(next.level)}**`];
  if (next.endorsements.length)
    parts.push(`Endorsements: ${next.endorsements.map(formatEndorsement).join(", ")}`);
  await channel.send(parts.join("\n"));
}

async function processAccountLinkOutbox(ctx, limit = 20) {
  if (String(process.env.BOOTCAMP_ACCOUNT_LINK_SYNC_ENABLED || "").trim().toLowerCase() !== "true") return 0;
  const { api, steamLinks, logger = console } = ctx;
  if (typeof steamLinks?.claimBootcampAccountLinkSync !== "function") return 0;
  if (!Object.values(licenseRoleIds(ctx.config)).some(Boolean)) return 0;
  let processed = 0;
  for (let i = 0; i < Math.max(1, Math.min(100, Number(limit) || 20)); i++) {
    let item;
    try { item = await steamLinks.claimBootcampAccountLinkSync(); }
    catch (error) {
      logger.warn?.(`[bootcampWatcher] account-link outbox claim failed: ${error.message}`);
      break;
    }
    if (!item) break;
    try {
      // Recompute through the Website, the authoritative Bootcamp license store,
      // before assigning Discord roles for the newly linked identities.
      await api.recomputeLicense(item.steam_id);
      await syncMemberRoles(ctx, item.discord_id);
      await steamLinks.completeBootcampAccountLinkSync(item.id);
      processed++;
    } catch (error) {
      const code = error?.code || error?.name || "sync_failed";
      try { await steamLinks.retryBootcampAccountLinkSync(item.id, item.attempts, code); }
      catch (retryError) { logger.error?.(`[bootcampWatcher] account-link outbox retry update failed: ${retryError.message}`); }
      logger.warn?.(`[bootcampWatcher] account-link role sync failed for discord=${item.discord_id}: ${error.message}`);
      // Preserve ordering; one transient failure should not churn later links.
      break;
    }
  }
  return processed;
}

/* ---------------------------------------------------------------------------
   Poll
   --------------------------------------------------------------------------- */
async function pollBootcampEvents(ctx) {
  if (running) return;
  running = true;
  const { client, api, settings, steamLinks, logger = console } = ctx;
  try {
    await processAccountLinkOutbox(ctx);
    if (String(process.env.BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED || "").trim().toLowerCase() === "true") {
      try { await announceWeeklyChallenge(ctx); }
      catch (error) { logger.warn?.(`[bootcampWatcher] weekly challenge announcement failed: ${error.message}`); }
    }
    let lastId = Number(settings?.getNumber?.(LAST_EVENT_KEY, -1) ?? -1);
    if (lastId < 0 || !Number.isFinite(lastId)) {
      // First start: begin at the end of the feed instead of replaying history.
      lastId = await api.latestEventId();
      settings?.setNumber?.(LAST_EVENT_KEY, lastId);
      return;
    }

    const events = await api.events(lastId, 200);
    if (!events.length) return;

    const channel = await findBootcampChannel(client);
    const touched = new Map();   // Steam ID -> player name

    for (const event of events) {
      const steamId = event.steamId;
      if (!steamId) continue;
      if (["tier_up", "lesson", "record"].includes(event.kind))
        await api.recomputeLicense(steamId);
      touched.set(steamId, event.playerName || "");
    }

    for (const [steamId] of touched) {
      const linked = (await steamLinks.getDiscordBySteam(steamId)) || [];
      for (const link of linked)
        await syncMemberRoles(ctx, link.discord_id);
    }

    // Advance after each successful delivery so a later Discord failure retries
    // only the undelivered events. Role synchronization above must also succeed
    // before publishing notifications or acknowledging this batch.
    for (const event of events) {
      const delivered = await postEvent(channel, api, event);
      if (!delivered) {
        logger.warn?.(`[bootcampWatcher] no notification channel; event ${event.id} remains queued`);
        return;
      }
      lastId = Math.max(lastId, Number(event.id));
      settings?.setNumber?.(LAST_EVENT_KEY, lastId);
    }
  } catch (err) {
    logger.error?.(`[bootcampWatcher] poll failed: ${err.message}`);
  } finally {
    running = false;
  }
}

async function startBootcampWatcher({ client, api, config = {}, settings, steamLinks, logger = console }) {
  if (String(process.env.BOOTCAMP_WATCHER_ENABLED || "").trim().toLowerCase() !== "true") {
    logger.info?.("[bootcampWatcher] disabled");
    return;
  }
  if (!client || !api || !steamLinks) {
    logger.warn?.("[bootcampWatcher] missing client, website API or Steam link store");
    return;
  }
  try {
    await api.latestEventId();
  } catch (err) {
    logger.info?.(`[bootcampWatcher] website API unavailable (${err.code || err.message}); not started`);
    return;
  }

  const pollMs = Number(process.env.BOOTCAMP_WATCHER_POLL_MS || DEFAULT_POLL_MS);
  const ctx = { client, api, config, settings, steamLinks, logger };
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
  licenseForDiscord,
  syncMemberRoles,
  postEvent,
  licenseRoleIds,
  rolesForLicense,
  formatTime,
  playerUrl,
  announceWeeklyChallenge,
  processAccountLinkOutbox,
};
