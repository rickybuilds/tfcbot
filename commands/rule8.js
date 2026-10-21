"use strict";

const { isAdmin } = require("../lib/guards");
const { sendAuditLog } = require("../lib/auditLog");

const INFRACTIONS_PER_JAIL = 5;
const JAIL_HOURS_PER_THRESHOLD = 24;

function register(reg, { config, elo, jailStore }) {
  reg.set("rule8", async (message) => {
    const user = message.mentions?.users?.first();
    const target = message.mentions?.members?.first();
    if (!user || !target) {
      await message.channel.send(
        "**Rule 8 — Have Fun**\n" +
        "We’re here to play, improve, and enjoy the game together.\n\n" +
        "To issue an infraction, use: `!rule8 @user`"
      );
      return;
    }
    if (!isAdmin(message)) return;
    if (String(user.id) === String(message.author.id)) {
      await message.channel.send("You cannot issue a Rule 8 infraction to yourself.");
      return;
    }

    try {
      const result = elo.recordRule8Infraction(
        user.id,
        message.author.id,
        target.displayName || user.username,
        message.member?.displayName || message.author.username,
      );
      let jailMessage = "";

      if (result.count % INFRACTIONS_PER_JAIL === 0) {
        const durationHours = (result.count / INFRACTIONS_PER_JAIL) * JAIL_HOURS_PER_THRESHOLD;
        const durationMs = durationHours * 60 * 60 * 1000;
        const existing = jailStore.get(target.id);

        if (!existing) {
          const oldRoles = target.roles.cache
            .filter(role => role.name !== "@everyone" && !role.managed)
            .map(role => role.id);
          for (const [, role] of target.roles.cache) {
            if (role.name === "@everyone" || role.managed) continue;
            await target.roles.remove(role).catch(() => {});
          }
          await target.roles.add(config.roles.jail).catch(() => {});
          jailStore.set(target.id, {
            oldRoles,
            expires: Date.now() + durationMs,
            reason: `Rule 8 — ${result.count} infractions`,
            admin: message.author.id,
          });
        } else {
          jailStore.set(target.id, {
            ...existing,
            expires: Math.max(Date.now(), existing.expires || 0) + durationMs,
            reason: `Rule 8 — ${result.count} infractions`,
            admin: message.author.id,
          });
        }
        jailMessage = ` They are jailed for ${durationHours} hours.`;
      }

      await message.channel.send(
        `⚖️ Rule 8 infraction for <@${target.id}> (${result.count}/5): ` +
        `**-1 Elo** transferred to <@${message.author.id}>.${jailMessage}`
      );
      await sendAuditLog({
        client: message.client,
        channelId: config?.channels?.audit,
        payload: `⚖️ RULE 8: <@${message.author.id}> issued an infraction to <@${target.id}>; ` +
          `Elo transferred ${result.target.before}→${result.target.after}, ` +
          `${result.issuer.before}→${result.issuer.after}; total ${result.count}`,
        errorMessage: "[rule8 audit] failed:",
      });
    } catch (err) {
      console.error("[!rule8 error]", err);
      await message.channel.send("Failed to record the Rule 8 infraction.");
    }
  });
}

module.exports = { register };
