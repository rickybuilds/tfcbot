"use strict";

const sqlite3 = require("sqlite3").verbose();
const mysql = require("mysql2/promise");
const { EmbedBuilder } = require("discord.js");
const servers = require("../config/rcon");
const { runRconCommand } = require("../services/rconClient");

const DB_PATH = "/root/tfcbot/elo.db";

const ALLOWED_MANAGERS = new Set([
  "255834576742645761", // Ricky
  "468578577537826831", // Rufio
]);

const ACCESS_LEVELS = {
  owner: "abcdefghijklmnopqrstu",
  admin: "bcdefghijmklmnopqrstu",
  user: "cfg",
};

const ACCOUNT_FLAGS = "ce";

function sqliteGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function amxxPool() {
  return mysql.createPool({
    host: process.env.AMXX_SQL_HOST,
    user: process.env.AMXX_SQL_USER,
    password: process.env.AMXX_SQL_PASS,
    database: process.env.AMXX_SQL_DB || "amxx",
    waitForConnections: true,
    connectionLimit: 2,
  });
}

function resolveAccess(level, customFlags) {
  const lvl = String(level || "").toLowerCase();

  if (lvl === "custom") {
    const flags = String(customFlags || "").trim();
    if (!flags) throw new Error("Custom requires flags. Example: !tfcadmin update @user custom cfg");
    if (!/^[a-y]+$/i.test(flags)) throw new Error("Custom flags must be letters a-y only. Do not use z.");
    if (flags.toLowerCase().includes("z")) throw new Error("Do not use z. z is non-admin.");
    return flags;
  }

  if (!ACCESS_LEVELS[lvl]) throw new Error("Level must be owner, admin, user, or custom.");
  return ACCESS_LEVELS[lvl];
}

function levelName(access) {
  if (access === ACCESS_LEVELS.owner) return "OWNER";
  if (access === ACCESS_LEVELS.admin) return "ADMIN";
  if (access === ACCESS_LEVELS.user) return "USER";
  return "CUSTOM";
}

function discordTime(value) {
  if (!value) return "Unknown";
  const ts = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(ts) ? `<t:${ts}:R>` : "Unknown";
}

async function getLinkedSteam(discordId) {
  return sqliteGet(`
    SELECT discord_id, steam_id, display_name
    FROM player_steam_ids
    WHERE discord_id = ?
    ORDER BY is_primary DESC, updated_at DESC, created_at DESC
    LIMIT 1
  `, [discordId]);
}

async function findTarget(message, args, targetIndex = 1) {
  const mentioned = message.mentions.users.first();
  if (mentioned) {
    const linked = await getLinkedSteam(mentioned.id);
    if (!linked?.steam_id) return null;
    return {
      discordId: mentioned.id,
      steamId: linked.steam_id,
      name: linked.display_name || mentioned.username || mentioned.id,
    };
  }

  const raw = String(args?.[targetIndex] || "").trim();
  if (!raw) return null;

  if (/^\d{17,20}$/.test(raw)) {
    const linked = await getLinkedSteam(raw);
    if (!linked?.steam_id) return null;
    return {
      discordId: raw,
      steamId: linked.steam_id,
      name: linked.display_name || raw,
    };
  }

  if (/^STEAM_\d+:\d+:\d+$/i.test(raw)) {
    const row = await sqliteGet(`
      SELECT discord_id, steam_id, display_name
      FROM player_steam_ids
      WHERE UPPER(steam_id) = UPPER(?)
      ORDER BY is_primary DESC, updated_at DESC, created_at DESC
      LIMIT 1
    `, [raw]);

    return {
      discordId: row?.discord_id || null,
      steamId: raw.toUpperCase(),
      name: row?.display_name || raw.toUpperCase(),
    };
  }

  const row = await sqliteGet(`
    SELECT discord_id, steam_id, display_name
    FROM player_steam_ids
    WHERE LOWER(display_name) = LOWER(?)
    ORDER BY is_primary DESC, updated_at DESC, created_at DESC
    LIMIT 1
  `, [raw]);

  if (!row?.steam_id) return null;

  return {
    discordId: row.discord_id,
    steamId: row.steam_id,
    name: row.display_name || raw,
  };
}

async function getSteamNameMap() {
  const rows = await sqliteAll(`
    SELECT steam_id, display_name
    FROM player_steam_ids
    WHERE steam_id IS NOT NULL AND steam_id != ''
  `);

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.steam_id) && r.display_name) {
      map.set(r.steam_id, r.display_name);
    }
  }

  return map;
}

async function reloadAdminsAllServers() {
  const results = [];

  for (const key of Object.keys(servers)) {
    try {
      await runRconCommand(key, "amx_reloadadmins");
      results.push(`✅ ${key}`);
    } catch (err) {
      results.push(`❌ ${key}: ${err.message || err}`);
    }
  }

  return results;
}

async function upsertAdmin(steamId, access, addedBy) {
  const pool = amxxPool();

  try {
    await pool.execute(`
      INSERT INTO admins(auth,password,access,flags,added_by,added_at)
      VALUES (?, '', ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        password='',
        access=VALUES(access),
        flags=VALUES(flags),
        added_by=VALUES(added_by),
        added_at=NOW()
    `, [steamId, access, ACCOUNT_FLAGS, addedBy]);
  } finally {
    await pool.end();
  }
}

async function deleteAdmin(steamId) {
  const pool = amxxPool();

  try {
    const [result] = await pool.execute(
      "DELETE FROM admins WHERE auth = ?",
      [steamId]
    );
    return result.affectedRows || 0;
  } finally {
    await pool.end();
  }
}

module.exports = {
  name: "tfcadmin",
  description: "Manage TFC AMXX SQL admins.",

  async execute(message, args) {
    if (!ALLOWED_MANAGERS.has(message.author.id)) {
      return message.reply("🚫 No permission to manage TFC admins.");
    }

    const cmd = String(args?.[0] || "").toLowerCase();

    if (!["update", "delete"].includes(cmd)) {
      return message.reply(
        "Usage:\n" +
        "`!tfcadmin update <@user|discordid|steamid|displayname> <owner|admin|user>`\n" +
        "`!tfcadmin update <@user|discordid|steamid|displayname> custom <flags>`\n" +
        "`!tfcadmin delete <@user|discordid|steamid|displayname>`"
      );
    }

    const target = await findTarget(message, args, 1);
    if (!target?.steamId) {
      return message.reply("❌ Target not found or STEAMID not linked.");
    }

    try {
      if (cmd === "delete") {
        const deleted = await deleteAdmin(target.steamId);
        const reloads = await reloadAdminsAllServers();

        return message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xef4444)
              .setTitle("TFC Admin Removed")
              .setDescription(
                `**${target.name}** • \`${target.steamId}\`\n` +
                `Rows deleted: \`${deleted}\`\n\n` +
                `**Reloaded admins**\n${reloads.join("\n")}`
              )
              .setTimestamp()
          ]
        });
      }

      const level = String(args?.[2] || "").toLowerCase();
      const customFlags = args?.[3];
      const access = resolveAccess(level, customFlags);

      await upsertAdmin(target.steamId, access, message.author.id);
      const reloads = await reloadAdminsAllServers();

      return message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle(`TFC Admin Updated`)
            .setDescription(
              `**${target.name}** • \`${target.steamId}\`\n` +
              `Level: **${levelName(access)}**\n` +
              `Access: \`${access}\`\n` +
              `Flags: \`${ACCOUNT_FLAGS}\`\n\n` +
              `**Reloaded admins**\n${reloads.join("\n")}`
            )
            .setTimestamp()
        ]
      });
    } catch (err) {
      console.error("[TFCADMIN ERROR]", err);
      return message.reply(`❌ TFC admin update failed: ${err.message || err}`);
    }
  },

  async list(message) {
    if (!ALLOWED_MANAGERS.has(message.author.id)) {
      return message.reply("🚫 No permission to view TFC admins.");
    }

    const pool = amxxPool();

    try {
      const [rows] = await pool.execute(`
        SELECT auth, access, flags, added_by, added_at
        FROM admins
        ORDER BY
          CASE
            WHEN access = 'abcdefghijklmnopqrstu' THEN 1
            WHEN access = 'bcdefghijmklmnopqrstu' THEN 2
            WHEN access = 'cfg' THEN 3
            ELSE 4
          END,
          auth ASC
      `);

      if (!rows.length) return message.reply("No TFC admins found.");

      const names = await getSteamNameMap();

      const lines = rows.map(r => {
        const name = names.get(r.auth) || "Unknown";
        const addedAt = discordTime(r.added_at);
        return `\`${name}\` • \`${r.auth}\` • **${levelName(r.access)}** • ${addedAt}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x3b82f6)
        .setTitle(`TFC SQL Admins (${rows.length})`)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({ text: "AMXX SQL admin database" })
        .setTimestamp();

      return message.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("[TFCADMINS ERROR]", err);
      return message.reply(`❌ Failed to load TFC admins: ${err.message || err}`);
    } finally {
      await pool.end();
    }
  },
};