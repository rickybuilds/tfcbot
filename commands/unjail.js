// commands/unjail.js
"use strict";

const { isAdmin } = require("../lib/guards");
const { sendAuditLog } = require("../lib/auditLog");

async function register(reg, deps) {
  const { jailStore, config } = deps;

  reg.set("unjail", async (message) => {
    if (!isAdmin(message)) return;

    const target = message.mentions.members.first();
    if (!target) return; // silent fail if no user mentioned

    const jailData = jailStore.get(target.id);
    if (!jailData) return; // silent fail if not in jail

    try {
      // remove jail role (from config.roles.jail)
      const jailRoleId = config.roles.jail;
      if (jailRoleId && target.roles.cache.has(jailRoleId)) {
        await target.roles.remove(jailRoleId);
      }

      // restore saved roles
      for (const roleId of jailData.oldRoles || []) {
        const role = target.guild.roles.cache.get(roleId);
        if (role) {
          await target.roles.add(role);
        }
      }

      // remove from store
      jailStore.delete(target.id);

      // also remove from bannedUsers state if present
      const { state } = require("../lib/state");
      if (state.bannedUsers) {
        state.bannedUsers.delete(String(target.id));
      }

      // ------------------ audit log ------------------
      await sendAuditLog({
        client: message.client,
        channelId: config?.channels?.audit,
        payload: `✅ MANUAL UNJAIL: <@${message.author.id}> unjailed <@${target.id}>`,
        errorMessage: "[unjail audit] failed:",
      });
      // ------------------------------------------------

    } catch (err) {
      console.error("[!unjail error]", err);
    }
  });
}

module.exports = { register };
