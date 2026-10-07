// commands/bootcamp.js
"use strict";

// Noname TFC Bootcamp commands:
//   !license [@player]                 license card
//   !pb <route>                        your personal best on a Bootcamp route
//   !challenge                         this week's challenge
//   !challenge set <route|drill> <slug> <map> <days> <title...>   (admin)
//   !cosign @player                    mentor co-sign on a license

const { isAdmin } = require("../lib/guards");
const { formatLevel, formatEndorsement, levelRank } = require("../lib/bootcampLicense");
const { licenseForDiscord, formatTime } = require("../services/bootcampWatcher");

const TIER_NAMES = ["None", "Bronze", "Silver", "Gold", "Platinum"];

function parseUserId(text) {
  const m = String(text || "").match(/^<@!?(\d{15,22})>$/) || String(text || "").match(/^(\d{15,22})$/);
  return m ? m[1] : null;
}

function siteUrl() {
  return (process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/$/, "");
}

async function steamIdsFor(steamLinks, discordId) {
  const rows = (await steamLinks?.getSteamIds?.(discordId).catch(() => [])) || [];
  return rows.map(r => r.steam_id).filter(Boolean);
}

function isMentor(message) {
  const roleId = process.env.BOOTCAMP_MENTOR_ROLE_ID || process.env.BOOTCAMP_PLATINUM_ROLE_ID || "";
  return isAdmin(message) || Boolean(roleId && message.member?.roles?.cache?.has(roleId));
}

async function licenseCard(message, args, { pool, steamLinks }) {
  const targetId = parseUserId(args[0]) || message.author.id;
  const steamIds = await steamIdsFor(steamLinks, targetId);
  if (!steamIds.length) {
    await message.reply(targetId === message.author.id
      ? "Link your Steam ID first (ask an admin to `!linksteam`), then your Bootcamp progress shows up here."
      : "That player has no linked Steam ID.");
    return;
  }

  const license = await licenseForDiscord(pool, steamLinks, targetId);
  const marks = steamIds.map(() => "?").join(",");
  const [tierRows] = await pool.query(
    `SELECT tier, COUNT(*) AS n FROM bootcamp_tiers WHERE steamid IN (${marks}) GROUP BY tier`,
    steamIds
  );
  const [lessonRows] = await pool.query(
    `SELECT DISTINCT lesson FROM bootcamp_lessons WHERE steamid IN (${marks}) ORDER BY lesson`,
    steamIds
  );
  const [cosign] = await pool.query(
    `SELECT cosigned_by FROM bootcamp_licenses WHERE steamid IN (${marks}) AND cosigned_by IS NOT NULL LIMIT 1`,
    steamIds
  );

  const counts = [0, 0, 0, 0, 0];
  for (const row of tierRows) counts[Number(row.tier)] = Number(row.n);

  const { EmbedBuilder } = require("discord.js");
  const embed = new EmbedBuilder()
    .setColor([0x888888, 0x5aa9ff, 0x57f287, 0x9cdcfe][levelRank(license.level)] || 0x888888)
    .setTitle(`TFC license: ${formatLevel(license.level)}`)
    .setDescription(`<@${targetId}>  ·  [Full card](${siteUrl()}/bootcamp-player.html?id=${encodeURIComponent(steamIds[0])})`)
    .addFields(
      { name: "Endorsements", value: license.endorsements.length ? license.endorsements.map(formatEndorsement).join(", ") : "None yet", inline: false },
      { name: "Tiers", value: `💎 ${counts[4]}  🥇 ${counts[3]}  🥈 ${counts[2]}  🥉 ${counts[1]}`, inline: true },
      { name: "Lessons", value: lessonRows.length ? lessonRows.map(r => r.lesson).join(", ") : "None yet", inline: true },
    );
  if (cosign[0]?.cosigned_by)
    embed.setFooter({ text: `Co-signed by ${cosign[0].cosigned_by}` });
  await message.channel.send({ embeds: [embed] });
}

async function personalBest(message, args, { pool, steamLinks }) {
  const slug = String(args[0] || "").toLowerCase();
  if (!slug) {
    await message.reply("Usage: `!pb <route slug>` (see the Bootcamp site for route names)");
    return;
  }
  const steamIds = await steamIdsFor(steamLinks, message.author.id);
  if (!steamIds.length) {
    await message.reply("Link your Steam ID first.");
    return;
  }
  const marks = steamIds.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT b.id, b.time_ms, b.tier, b.class_id, r.name, r.map
       FROM bootcamp_runs b
       JOIN bootcamp_routes r ON r.id = b.route_id AND r.config_version = b.config_version
      WHERE r.slug = ? AND b.steamid IN (${marks}) AND b.valid = 1 AND b.mode = 1
      ORDER BY b.time_ms ASC LIMIT 1`,
    [slug, ...steamIds]
  );
  if (!rows.length) {
    await message.reply(`No ranked run on \`${slug}\` yet.`);
    return;
  }
  const run = rows[0];
  await message.reply(
    `**${run.name}** (${run.map}): **${formatTime(run.time_ms)}**` +
    (Number(run.tier) ? ` · ${TIER_NAMES[Number(run.tier)]}` : "") +
    `\n${siteUrl()}/speedrun-replay.html?bootcampRunId=${run.id}`
  );
}

async function challenge(message, args, { pool }) {
  if (String(args[0] || "").toLowerCase() === "set") {
    if (!isAdmin(message)) return;
    const [, type, slug, map, daysText, ...titleWords] = args;
    const days = Number(daysText);
    if (!["route", "drill"].includes(type) || !slug || !map || !Number.isFinite(days) || days <= 0 || !titleWords.length) {
      await message.reply("Usage: `!challenge set <route|drill> <slug> <map> <days> <title...>`");
      return;
    }
    const table = type === "route" ? "bootcamp_routes" : "bootcamp_drills";
    const [targets] = await pool.query(`SELECT id, name FROM ${table} WHERE slug = ? AND map = ? LIMIT 1`, [slug, map]);
    if (!targets.length) {
      await message.reply(`No ${type} \`${slug}\` on ${map}.`);
      return;
    }
    await pool.query(
      `INSERT INTO bootcamp_challenges (title, target_type, target_id, starts_at, ends_at, created_by)
       VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), ?)`,
      [titleWords.join(" "), type, targets[0].id, Math.floor(days), message.author.username]
    );
    await message.reply(`Challenge set: **${titleWords.join(" ")}** on ${targets[0].name} (${map}) for ${Math.floor(days)} days.`);
    return;
  }

  const [rows] = await pool.query(
    `SELECT c.id, c.title, c.target_type, c.target_id, c.ends_at,
            COALESCE(r.name, d.name) AS target_name, COALESCE(r.map, d.map) AS map
       FROM bootcamp_challenges c
       LEFT JOIN bootcamp_routes r ON c.target_type = 'route' AND r.id = c.target_id
       LEFT JOIN bootcamp_drills d ON c.target_type = 'drill' AND d.id = c.target_id
      WHERE NOW() BETWEEN c.starts_at AND c.ends_at
      ORDER BY c.starts_at DESC LIMIT 1`
  );
  if (!rows.length) {
    await message.reply("No Bootcamp challenge is running right now.");
    return;
  }
  const c = rows[0];
  const board = c.target_type === "route"
    ? (await pool.query(
        `SELECT player_name, MIN(time_ms) AS best FROM bootcamp_runs
          WHERE route_id = ? AND valid = 1 AND mode = 1 AND created_at >= (SELECT starts_at FROM bootcamp_challenges WHERE id = ?)
          GROUP BY steamid, player_name ORDER BY best ASC LIMIT 5`, [c.target_id, c.id]))[0]
          .map((row, i) => `${i + 1}. ${row.player_name} ${formatTime(row.best)}`)
    : (await pool.query(
        `SELECT player_name, MAX(score) AS best FROM bootcamp_drill_sets
          WHERE drill_id = ? AND created_at >= (SELECT starts_at FROM bootcamp_challenges WHERE id = ?)
          GROUP BY steamid, player_name ORDER BY best DESC LIMIT 5`, [c.target_id, c.id]))[0]
          .map((row, i) => `${i + 1}. ${row.player_name} ${Math.round(Number(row.best))}`);
  await message.reply(
    `**${c.title}**: ${c.target_name} (${c.map}), ends <t:${Math.floor(new Date(c.ends_at).getTime() / 1000)}:R>\n` +
    (board.length ? board.join("\n") : "No entries yet.")
  );
}

async function cosign(message, args, { pool, steamLinks }) {
  if (!isMentor(message)) {
    await message.reply("Only mentors (platinum license holders) and admins can co-sign.");
    return;
  }
  const targetId = parseUserId(args[0]);
  if (!targetId || targetId === message.author.id) {
    await message.reply("Usage: `!cosign @player` (after watching them in a learning pug)");
    return;
  }
  const steamIds = await steamIdsFor(steamLinks, targetId);
  if (!steamIds.length) {
    await message.reply("That player has no linked Steam ID.");
    return;
  }
  const by = message.member?.displayName || message.author.username;
  for (const steamid of steamIds) {
    await pool.query(
      `INSERT INTO bootcamp_licenses (steamid, cosigned_by) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE cosigned_by = VALUES(cosigned_by)`,
      [steamid, by]
    );
  }
  await message.reply(`<@${targetId}>'s license is co-signed by ${by}.`);
}

function register(reg, deps) {
  const wrap = fn => async (message, args = []) => {
    if (!deps.pool) {
      await message.reply("Bootcamp isn't connected to the database.").catch(() => {});
      return;
    }
    try {
      await fn(message, args, deps);
    } catch (err) {
      console.error("[bootcamp] command failed:", err);
      await message.reply("Bootcamp data isn't available right now.").catch(() => {});
    }
  };
  reg.set("license", wrap(licenseCard));
  reg.set("pb", wrap(personalBest));
  reg.set("challenge", wrap(challenge));
  reg.set("cosign", wrap(cosign));
}

module.exports = { register, parseUserId, isMentor };
