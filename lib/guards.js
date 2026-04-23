// lib/guards.js
"use strict";

function isAdmin(message) {
  const roleId = process.env.ADMIN_ROLE_ID || "";
  return roleId && message.member?.roles?.cache?.has(roleId);
}

function isEloManager(message) {
  const roleId = process.env.ELO_ROLE_ID || "";
  return roleId && message.member?.roles?.cache?.has(roleId);
}

function inEloAdminChannel(message) {
  const chanId = process.env.ELO_ADMIN_CHANNEL_ID || "";
  return chanId && message.channel?.id === chanId;
}

// 👇 Add this back
async function guardChannel(message, allowed) {
  if (!allowed) return false;

  // If you pass a single string, wrap to array
  const ids = Array.isArray(allowed) ? allowed : [String(allowed)];

  if (!ids.includes(String(message.channel?.id))) {
    try {
      await message.reply("⚠️ Wrong channel for this command.");
    } catch {}
    return false;
  }
  return true;
}

module.exports = { isAdmin, isEloManager, inEloAdminChannel, guardChannel };
