// commands/purgematches.js
"use strict";

const { guardChannel, isAdmin } = require("../lib/guards");

function register(reg, { state, matchesStore, config }) {
  const ADMIN_CH = String(config.ELO_ADMIN_CHANNEL_ID || ""); // same admin channel
  const SUPERUSER_ID = String(config.ELO_PURGE_SUPERUSER_ID || "255834576742645761");

  reg.set("purgematches", async (message, args = []) => {
    if (!(await guardChannel(message, ADMIN_CH))) return;
    if (String(message.author.id) !== SUPERUSER_ID) {
      return message.channel.send("⛔ Only the designated owner can run purge commands.");
    }

    try {
      // 1) Clear in-memory matches
      state.matches = [];

      // 2) Clear persisted DB
      if (matchesStore?.db) {
        matchesStore.db.prepare(`DELETE FROM matches`).run();
      } else if (matchesStore?.saveMatch) {
        // fallback if only file-backed
        try { matchesStore.saveMatch([]); } catch {}
      }

      await message.channel.send("🧨 Purged **all matches** from `elo.db` and memory.");
    } catch (e) {
      console.error("[purgematches] failed:", e);
      await message.channel.send("❌ Failed to purge matches. Check logs.");
    }
  });
}

module.exports = { register };
