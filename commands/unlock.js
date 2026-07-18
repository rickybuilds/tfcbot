"use strict";

/**
 * !unlock <matchId>
 * Admin-only command to manually clear a stuck server lock.
 * Only allowed in MAPS_CHANNEL_ID.
 */

const { isAdmin } = require("../lib/guards");
const { state, unlockServer } = require("../lib/state");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

module.exports = {
  name: "unlock",
  description: "Force-unlock a stuck server (admin only). Usage: !unlock <matchId>",

  async execute(message, args, deps) {
    try {
      const MAPS_CHANNEL_ID = String(process.env.MAPS_CHANNEL_ID || "");
      if (String(message.channel?.id) !== MAPS_CHANNEL_ID) {
        return message.reply("⚠️ This command can only be used in the maps/admin channel.");
      }

      // ✅ admin check
      if (!isAdmin(message)) {
        return message.reply("🚫 You do not have permission to use this command.");
      }

      const matchId = args[0]?.trim().toUpperCase();
      if (!matchId) {
        return message.reply("Usage: `!unlock <matchId>`");
      }

      const dbPath = path.resolve("/root/tfcbot/elo.db");
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

      db.get(
        "SELECT server_name FROM matches WHERE match_id = ?",
        [matchId],
        (err, row) => {
          if (err) {
            console.error("[!unlock] DB error:", err);
            message.reply("❌ Database error while looking up that match.");
            db.close();
            return;
          }

          if (!row) {
            message.reply(`⚠️ No match found with ID **${matchId}**.`);
            db.close();
            return;
          }

          const serverName = String(row.server_name || "").trim();
          const server = state.servers.find(
            (s) => s.name.toLowerCase() === serverName.toLowerCase()
          );

          if (!server) {
            message.reply(`⚠️ No server record found for **${serverName}** in state.`);
            db.close();
            return;
          }

          const result = unlockServer(server.ip);
          db.close();

          if (result) {
            console.log(`[!unlock] ✅ Force-unlocked server ${server.ip} (${serverName})`);
            message.reply(
              `✅ Server **${serverName}** (${server.ip}) unlocked successfully.`
            );
          } else {
            console.log(`[!unlock] ℹ️ Server ${server.ip} (${serverName}) was not locked.`);
            message.reply(
              `ℹ️ Server **${serverName}** (${server.ip}) was already unlocked (nothing to do).`
            );
          }
        }
      );
    } catch (e) {
      console.error("[!unlock] Unexpected error:", e);
      try {
        await message.reply("❌ Unexpected error occurred while unlocking.");
      } catch {}
    }
  },
};
