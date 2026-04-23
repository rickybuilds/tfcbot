// lib/jailWatcher.js
"use strict";

const { state } = require("./state");

const JAIL_ROLE_ID = process.env.JAIL_ROLE_ID || "";
const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID || "";

// "infinite" timestamp (year 2999)
const INFINITE_JAIL = 32503680000000; // 2999-01-01T00:00:00Z

async function unjailMember(guild, userId, jailData, jailStore) {
  const member = await guild.members.fetch(userId).catch(() => null);

  // ⚠️ If user left the server — set infinite jail instead of releasing
  if (!member) {
    // If not already infinite, mark them indefinite
    if (jailData.expires < INFINITE_JAIL) {
      jailData.expires = INFINITE_JAIL;
      jailStore.set(userId, jailData);

      if (AUDIT_CHANNEL_ID) {
        const auditCh = guild.channels.cache.get(AUDIT_CHANNEL_ID);
        auditCh?.send(
          `🚪 User <@${userId}> left the server while jailed — jail made **indefinite** until manual unjail.`
        ).catch(() => {});
      }
    }
    return;
  }

  try {
    // Normal unjail flow
    if (JAIL_ROLE_ID) await member.roles.remove(JAIL_ROLE_ID).catch(() => {});
    for (const roleId of jailData.oldRoles || []) {
      const role = guild.roles.cache.get(roleId);
      if (role) await member.roles.add(role).catch(() => {});
    }

    jailStore.delete(userId);
    state.bannedUsers.delete(String(userId));

    if (AUDIT_CHANNEL_ID) {
      const auditCh = guild.channels.cache.get(AUDIT_CHANNEL_ID);
      auditCh?.send(
        `✅ UNJAIL: ${member} has been released (was jailed for "${jailData.reason || "unspecified"}")`
      ).catch(() => {});
    }
  } catch (err) {
    console.error("[unjailMember] error:", err);
  }
}

function startJailWatcher(client, jailStore) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;

    try {
      const now = Date.now();
      for (const [userId, jailData] of Object.entries(jailStore.all())) {
        if (jailData.expires <= now && jailData.expires < INFINITE_JAIL) {
          for (const guild of client.guilds.cache.values()) {
            await unjailMember(guild, userId, jailData, jailStore);
          }
        }
      }
    } finally {
      running = false;
    }
  }, 60 * 1000); // check every 60 seconds
}

module.exports = { startJailWatcher, unjailMember };
