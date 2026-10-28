"use strict";

const ms = require("ms");
const { isAdmin } = require("../lib/guards");
const { sendAuditLog } = require("../lib/auditLog");

const INFINITE_JAIL = 32503680000000;

async function register(reg, deps) {
  const { config, jailStore } = deps;

  reg.set("reducejail", async (message, args) => {
    if (!isAdmin(message)) return;

    const target = message.mentions.members.first();
    const durationStr = args[1];
    const reason = args.slice(2).join(" ").trim();
    if (!target || !durationStr || !reason) {
      await message.channel.send("Usage: `!reducejail @user <duration> <reason>` — example: `!reducejail @user 6h good behaviour`");
      return;
    }

    let durationMs;
    try { durationMs = ms(durationStr); } catch {}
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      await message.channel.send("Invalid duration. Use a positive duration such as `30m`, `6h`, or `2d`.");
      return;
    }

    const jailData = jailStore.get(target.id);
    if (!jailData) {
      await message.channel.send(`<@${target.id}> is not currently in jail.`);
      return;
    }
    if (!Number.isSafeInteger(jailData.expires) || jailData.expires >= INFINITE_JAIL) {
      await message.channel.send("This sentence is indefinite or has no valid release time. Use `!unjail @user` to release them.");
      return;
    }

    const now = Date.now();
    const expires = Math.max(now, jailData.expires - durationMs);
    const released = expires <= now;
    try {
      if (released) {
        // Keep the record until role restoration succeeds so a failed release can be retried.
        const jailRoleId = config.roles.jail;
        if (jailRoleId && target.roles.cache.has(jailRoleId)) {
          await target.roles.remove(jailRoleId);
        }
        for (const roleId of jailData.oldRoles || []) {
          const role = target.guild.roles.cache.get(roleId);
          if (role) await target.roles.add(role);
        }
        jailStore.delete(target.id);
        const { state } = require("../lib/state");
        state.bannedUsers?.delete(String(target.id));
      } else {
        jailStore.set(target.id, { ...jailData, expires });
      }
    } catch (err) {
      console.error("[!reducejail error]", err);
      await message.channel.send("Failed to reduce the jail sentence. Check the bot's role permissions and try again.");
      return;
    }

    const outcome = released ? "released immediately" : `new release time: <t:${Math.floor(expires / 1000)}:F>`;
    await sendAuditLog({
      client: message.client,
      channelId: config?.channels?.audit,
      payload: `JAIL REDUCTION: <@${message.author.id}> reduced <@${target.id}>'s sentence by ${durationStr} — "${reason}"; ${outcome}. Previous release: <t:${Math.floor(jailData.expires / 1000)}:F>`,
      errorMessage: "[reducejail audit] failed:",
    });
    await message.channel.send(`<@${target.id}>'s jail sentence reduced by ${durationStr} — "${reason}"; ${outcome}.`);
  });
}

module.exports = { register };
