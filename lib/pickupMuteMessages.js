"use strict";

const fs = require("fs");
const path = require("path");

const ALLOWED_PICKUP_MUTED_MESSAGES = new Set([
  "!add", "!addadl", "++", "**", "!addoff", "++off",
]);

async function enforcePickupMuteMessage(message, mutedUsers, file = path.join(process.cwd(), "mutedlogs.json")) {
  if (!message?.guild || message.author?.bot) return false;
  if (!mutedUsers?.has(String(message.author?.id))) return false;
  if (ALLOWED_PICKUP_MUTED_MESSAGES.has(String(message.content || "").trim().toLowerCase())) return false;

  try {
    const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    if (!Array.isArray(entries)) throw new Error("muted log must contain an array");
    entries.push({
      timestamp: new Date().toISOString(),
      userId: message.author.id,
      username: message.author.username,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelId: message.channel?.id,
      channelName: message.channel?.name,
      messageId: message.id,
      content: message.content || "",
    });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn("[pickup_mute] message log failed:", err.message);
  }

  try {
    await message.delete();
  } catch (err) {
    console.warn("[pickup_mute] delete failed:", err.message);
  }
  return true;
}

module.exports = { enforcePickupMuteMessage };
