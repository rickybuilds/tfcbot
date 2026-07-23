// commands/settings.js
"use strict";

const { PermissionsBitField, EmbedBuilder } = require("discord.js");
const {
  DEFAULT_TEAM1_STARTS,
  TEAM1_STARTS_SETTING,
  getTeamStartLockReason,
  isValidTeam1Starts,
  normalizeTeam1Starts,
} = require("../lib/teamStart");

function isAdmin(message, config) {
  try {
    const m = message.member;
    if (!m) return false;
    if (m.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    const roleId = String(config.roles.admin || "");
    return roleId && m.roles?.cache?.has(roleId);
  } catch {
    return false;
  }
}

function isTrueyString(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "y"].includes(s);
}

function canSendEmbeds(message) {
  try {
    if (!message.guild) return true;
    const me = message.guild.members.me;
    if (!me) return false;
    const perms = me.permissionsIn(message.channel);
    return perms.has(PermissionsBitField.Flags.ViewChannel) &&
           perms.has(PermissionsBitField.Flags.SendMessages) &&
           perms.has(PermissionsBitField.Flags.EmbedLinks);
  } catch { return false; }
}
function canSendPlain(message) {
  try {
    if (!message.guild) return true;
    const me = message.guild.members.me;
    if (!me) return false;
    const perms = me.permissionsIn(message.channel);
    return perms.has(PermissionsBitField.Flags.ViewChannel) &&
           perms.has(PermissionsBitField.Flags.SendMessages);
  } catch { return false; }
}

function register(registry, deps) {
  const { settings, config, state } = deps;

  const DEFAULTS = {
    "queue:idle_min":       120,
    "decay:percent":        5,
    "decay:min":            10,
    "decay:cooldown_days":  90,
    "backup:enabled":       true,
    "backup:time":          "04:00",
    "vote:server_duration": 120,
    "vote:map_duration":    60,
    [TEAM1_STARTS_SETTING]: DEFAULT_TEAM1_STARTS,
  };

  const SETTINGS_CHANNEL = config.channels.settings || ""; // 👈 from .env

  // ---- !settings (view) ----
  registry.set("settings", async (message) => {
    if (SETTINGS_CHANNEL && String(message.channel?.id) !== SETTINGS_CHANNEL) return;

    const emb = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Bot Settings")
      .addFields(
        { name: "Queue Idle (min)",      value: String(settings.getNumber("queue:idle_min", DEFAULTS["queue:idle_min"])), inline: true },
        { name: "Decay %",               value: String(settings.getNumber("decay:percent", DEFAULTS["decay:percent"])), inline: true },
        { name: "Decay Min",             value: String(settings.getNumber("decay:min", DEFAULTS["decay:min"])), inline: true },
        { name: "Decay Cooldown (days)", value: String(settings.getNumber("decay:cooldown_days", DEFAULTS["decay:cooldown_days"])), inline: true },
        { name: "Backups Enabled",       value: settings.getBool("backup:enabled", DEFAULTS["backup:enabled"]) ? "on" : "off", inline: true },
        { name: "Backup Time",           value: settings.getString("backup:time", DEFAULTS["backup:time"]), inline: true },
        { name: "Server Vote Duration (sec)", value: String(settings.getNumber("vote:server_duration", DEFAULTS["vote:server_duration"])), inline: true },
        { name: "Map Vote Duration (sec)",    value: String(settings.getNumber("vote:map_duration", DEFAULTS["vote:map_duration"])), inline: true },
        { name: "Team 1 Starts", value: settings.getString(TEAM1_STARTS_SETTING, DEFAULTS[TEAM1_STARTS_SETTING]), inline: true },
        { name: "Settings Channel",      value: SETTINGS_CHANNEL ? `<#${SETTINGS_CHANNEL}>` : "_not set_", inline: false },
      )
      .setFooter({ text: "Use !set <key> <value> (admin only)" })
      .setTimestamp();

    if (canSendEmbeds(message)) {
      await message.channel.send({ embeds: [emb] });
    } else if (canSendPlain(message)) {
      await message.channel.send("Bot Settings:\n" +
        `• Queue Idle (min): ${settings.getNumber("queue:idle_min", DEFAULTS["queue:idle_min"])}\n` +
        `• Decay %: ${settings.getNumber("decay:percent", DEFAULTS["decay:percent"])}\n` +
        `• Decay Min: ${settings.getNumber("decay:min", DEFAULTS["decay:min"])}\n` +
        `• Decay Cooldown (days): ${settings.getNumber("decay:cooldown_days", DEFAULTS["decay:cooldown_days"])}\n` +
        `• Backups Enabled: ${settings.getBool("backup:enabled", DEFAULTS["backup:enabled"]) ? "on" : "off"}\n` +
        `• Backup Time: ${settings.getString("backup:time", DEFAULTS["backup:time"])}\n` +
        `• Server Vote Duration (sec): ${settings.getNumber("vote:server_duration", DEFAULTS["vote:server_duration"])}\n` +
        `• Map Vote Duration (sec): ${settings.getNumber("vote:map_duration", DEFAULTS["vote:map_duration"])}\n` +
        `• Team 1 Starts: ${settings.getString(TEAM1_STARTS_SETTING, DEFAULTS[TEAM1_STARTS_SETTING])}\n` +
        `• Settings Channel: ${SETTINGS_CHANNEL ? `<#${SETTINGS_CHANNEL}>` : "_not set_"}`);
    } else {
      const dm = await message.author.createDM();
      await dm.send({ embeds: [emb] });
    }
  });

  // ---- !set <key> <value> ----
  registry.set("set", async (message, args = []) => {
    if (SETTINGS_CHANNEL && String(message.channel?.id) !== SETTINGS_CHANNEL) return;
    if (!isAdmin(message, config)) return;

    const [keyRaw, ...rest] = args;
    const key = (keyRaw || "").toLowerCase();
    const val = (rest.join(" ") || "").trim();
    if (!key || !val) return message.channel.send("Usage: `!set <key> <value>`");

    const allowed = new Set([
      "queue:idle_min",
      "decay:percent",
      "decay:min",
      "decay:cooldown_days",
      "backup:enabled",
      "backup:time",
      "settings:channel_id",
      "vote:server_duration",
      "vote:map_duration",
      TEAM1_STARTS_SETTING,
    ]);
    if (!allowed.has(key)) return message.channel.send("Unknown key.");

    let n;
    let savedValue = val;
    if (key === TEAM1_STARTS_SETTING) {
      const lockReason = getTeamStartLockReason(state);
      if (lockReason) {
        const current = normalizeTeam1Starts(
          settings.getString(TEAM1_STARTS_SETTING, DEFAULT_TEAM1_STARTS),
        );
        return message.channel.send(
          `⚠️ Team starting order cannot be changed while a ${lockReason} is active. ` +
          `Current setting remains: Team 1 starts **${current}**.`
        );
      }
      const valueParts = val.split(/\s+/).filter(Boolean);
      const requestedStart = valueParts[0];
      const targetMatchId = valueParts[1] || null;
      if (valueParts.length > 2) {
        return message.channel.send(
          `Usage: \`!set ${TEAM1_STARTS_SETTING} <offense|defense> [matchId]\``
        );
      }
      if (!isValidTeam1Starts(requestedStart)) {
        return message.channel.send(
          `\`${TEAM1_STARTS_SETTING}\` must be \`offense\` or \`defense\`.`
        );
      }
      savedValue = normalizeTeam1Starts(requestedStart);
      settings.setString(key, savedValue);
      const activeUpdate =
        await state?.autoRecap?.updateTeam1Starts?.(
          savedValue,
          targetMatchId
        );

      if (activeUpdate?.ambiguous) {
        await message.channel.send(
          `ℹ️ Saved the default, but multiple matches are armed. ` +
          `Run \`!set ${TEAM1_STARTS_SETTING} ${savedValue} <matchId>\` ` +
          `to update one of them: ${activeUpdate.matchIds.join(", ")}`
        );
      } else if (activeUpdate?.updated?.length) {
        await message.channel.send(
          `🔄 Updated armed match${activeUpdate.updated.length === 1 ? "" : "es"} ` +
          `${activeUpdate.updated.join(", ")}: Team 1 starts **${savedValue}**.`
        );
      } else if (activeUpdate?.blocked?.length) {
        await message.channel.send(
          `ℹ️ The default was saved, but the active match was not changed: ` +
          activeUpdate.blocked.map(x => `${x.matchId} (${x.reason})`).join(", ")
        );
      }
    } else if (key === "queue:idle_min") {
      n = Number(val);
      if (!Number.isFinite(n) || n < 1 || n > 180) return message.channel.send("`queue:idle_min` must be 1–180.");
      settings.setNumber(key, n);
    } else if (key === "decay:percent") {
      n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 20) return message.channel.send("`decay:percent` must be 0–20.");
      settings.setNumber(key, n);
    } else if (key === "decay:min") {
      n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 100) return message.channel.send("`decay:min` must be 0–100.");
      settings.setNumber(key, n);
    } else if (key === "decay:cooldown_days") {
      n = Number(val);
      if (!Number.isFinite(n) || n < 1 || n > 90) return message.channel.send("`decay:cooldown_days` must be 1–90.");
      settings.setNumber(key, n);
    } else if (key === "backup:enabled") {
      settings.setBool(key, isTrueyString(val));
    } else if (key === "backup:time") {
      if (!/^\d{2}:\d{2}$/.test(val)) return message.channel.send("`backup:time` must be HH:MM (24h).");
      settings.setString(key, val);
    } else if (key === "settings:channel_id") {
      if (!/^\d{17,20}$/.test(val)) return message.channel.send("`settings:channel_id` must be a numeric channel ID.");
      settings.setString(key, val);
    } else if (key === "vote:server_duration" || key === "vote:map_duration") {
      n = Number(val);
      if (!Number.isFinite(n) || n < 5 || n > 120) return message.channel.send("Vote durations must be 5–120 seconds.");
      settings.setNumber(key, n);
    }

    await message.channel.send(`✅ Saved: \`${key}\` = \`${savedValue}\``);
  });

  registry.set("settings:set", registry.get("set"));
  registry.set("cfg", registry.get("set"));
}

module.exports = { register };
