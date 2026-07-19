// commands/privacy.js
"use strict";

const config = require("../config");
const { sendAuditLog } = require("../lib/auditLog");

function register(reg, { privacy }) {
  reg.set("privacy", async (message, args) => {
    const id = String(message.author.id);
    const userTag = message.author.tag;
    const guild = message.guild;
    const arg = (Array.isArray(args) ? args[0] : args)?.toLowerCase?.() || "";

    // Clean up original command if possible
    if (message.deletable) {
      try { await message.delete(); } catch {}
    }

    // No argument → just show current status
    if (!["on", "off"].includes(arg)) {
      const current = privacy.isHidden(id);
      try {
        await message.author.send(
          `🕶️ Privacy is currently **${current ? "ON" : "OFF"}**.\nUse \`!privacy on\` or \`!privacy off\`.`
        );
      } catch {
        await message.channel.send(`<@${id}> I couldn't DM you. Please enable DMs from this server.`)
          .then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
      }
      return;
    }

    // Current state
    const currentHidden = privacy.isHidden(id);
    const requestedHidden = arg === "on";

    // 🛑 Ignore if already in that state
    if (currentHidden === requestedHidden) {
      try {
        await message.author.send(
          requestedHidden
            ? "🕶️ Privacy is already **ON** — no changes made."
            : "🕶️ Privacy is already **OFF** — no changes made."
        );
      } catch {}
      return;
    }

    // ✅ Apply new state
    privacy.setHidden(id, requestedHidden);

    const dmMsg = requestedHidden
      ? "🔒 Privacy enabled — you’ll show as ❓ in queues and match embeds."
      : "🔓 Privacy disabled — your rank badge will show again.";

    try {
      await message.author.send(dmMsg);
    } catch {
      await message.channel.send(`<@${id}> I couldn't DM you your privacy status. Please enable DMs.`)
        .then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
    }

    // 🧾 Log to audit channel (if available)
    await sendAuditLog({
      client: message.client,
      guild,
      channelId: config.channels.audit,
      payload: {
        content: `🕶️ **Privacy ${requestedHidden ? "ENABLED" : "DISABLED"}** by <@${id}> (${userTag})`,
      },
      cacheFirst: true,
      requireTextBased: false,
      missingMessage: "[privacy.js] ⚠️ Audit channel not found or not accessible.",
      errorMessage: "[privacy.js] Failed to log to audit channel:",
      errorLevel: "error",
    });
  });
}

module.exports = { register };
