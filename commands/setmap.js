// commands/setmap.js
"use strict";

const { isAdmin } = require("../lib/guards");
const { sendAuditLog } = require("../lib/auditLog");

async function register(reg, deps) {
  const { elo, config, state } = deps;

  reg.set("setmap", async (message, args) => {
    if (!isAdmin(message)) return;

    const matchId = args?.[0];
    const newMap = (args || []).slice(1).join(" ").trim();

    if (!matchId || !newMap) {
      await message.reply("Usage: `!setmap <matchid> <map>`");
      return;
    }

    try {
      // --- Check match status ---
      const matchRow = elo.db
        .prepare("SELECT match_id, map_name, status FROM matches WHERE match_id = ?")
        .get(matchId);

      if (!matchRow) {
        await message.reply(`⚠️ No match found with ID **${matchId}**`);
        return;
      }

      const currentStatus = String(matchRow.status || "").toLowerCase();
      if (currentStatus !== "in_progress") {
        await message.reply(
          `🚫 Cannot change map — match **${matchId}** is **${currentStatus.toUpperCase()}**.`
        );
        return;
      }

      // --- Perform update (DB) ---
      const res = elo.db
        .prepare("UPDATE matches SET map_name = ? WHERE match_id = ?")
        .run(newMap, matchId);

      if (!res || res.changes <= 0) {
        await message.reply(`⚠️ No map change was made (already set to **${newMap}**?)`);
        return;
      }

      // --- Update in-memory match record (best effort) ---
      try {
        const mem = (state.matches || []).find((m) => String(m?.id) === String(matchId));
        if (mem) {
          mem.map = newMap;
          if ("map_name" in mem) mem.map_name = newMap;
        }
      } catch (e) {
        console.warn("[setmap] failed to update state.matches:", e);
      }

      // --- Update autoRecap armed state (THIS is the key fix) ---
      let didAutoRecap = false;
      try {
        didAutoRecap = !!state.autoRecap?.updateArmedMap?.(matchId, newMap);
      } catch (e) {
        console.warn("[setmap] updateArmedMap failed:", e);
      }

      // --- Respond ---
      await message.reply(`✅ Updated map for match **${matchId}** → **${newMap}**`);
      if (didAutoRecap) {
        await message.channel.send(
          `🧠 autoRecap updated — now tracking **${newMap}** for match **${matchId}**`
        );
      } else {
        await message.channel.send(
          `ℹ️ DB updated, but autoRecap had no armed entry for match **${matchId}**`
        );
      }

      // --- Audit log ---
      await sendAuditLog({
        client: message.client,
        channelId: config?.channels?.audit,
        payload: `🗺️ **SETMAP:** <@${message.author.id}> changed map for **${matchId}** → **${newMap}**`,
        errorMessage: "[setmap audit] failed:",
      });
    } catch (err) {
      console.error("[!setmap error]", err);
      await message.reply("❌ Failed to update map. Check logs for details.");
    }
  });
}

module.exports = { register };
