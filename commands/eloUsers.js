// commands/eloUsers.js
"use strict";

const { EmbedBuilder, codeBlock } = require("discord.js");
const EloAny = require("../lib/elo");
const { PrivacyDB } = require("../lib/privacy");
const { guardChannel } = require("../lib/guards");

const ADMIN_ROLE = process.env.ADMIN_ROLE_ID || "";
const ALLOWED_CHANNELS = (process.env.ADMIN_CHANNELS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

function isAdmin(message) {
  return ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);
}

// Ensure we always have a working DB handle
const EloDB =
  typeof EloAny.EloDB === "function" ? new EloAny.EloDB("elo.db") : EloAny;
const db = EloDB.db || EloDB; // <-- main fix

module.exports = {
  name: ["allelo", "deluser"],
  async execute(message, args, state) {
    if (!isAdmin(message)) return;
    if (!guardChannel(message.channelId, ALLOWED_CHANNELS)) return;

    const cmd = (args[0] || "").toLowerCase();

    // --------------------- !allelo ---------------------
    if (message.content.startsWith("!allelo")) {
      try {
        const rows = db
          .prepare(
            `SELECT player_id, display_name, rating FROM ratings ORDER BY rating DESC`
          )
          .all();

        const privacy = {};
        try {
          const allPriv = PrivacyDB.getAll?.() || [];
          for (const p of allPriv) {
            privacy[p.player_id] = p.is_private ? "🔒" : "";
          }
        } catch {
          // fine if privacy not available
        }

        const lines = rows.map(
          (r, i) =>
            `${String(i + 1).padStart(3, " ")}. ${r.display_name} (${r.player_id}) — **${r.rating}** ${
              privacy[r.player_id] || ""
            }`
        );

        if (!lines.length)
          return message.reply("No users found in Elo database.");

        const chunkSize = 20;
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunk = lines.slice(i, i + chunkSize).join("\n");
          const embed = new EmbedBuilder()
            .setColor("#00862F")
            .setTitle("📊 Elo User List")
            .setDescription(codeBlock(chunk))
            .setFooter({ text: `Total: ${rows.length} users` });
          await message.channel.send({ embeds: [embed] });
        }
      } catch (e) {
        console.error("[!allelo error]", e);
        await message.reply(`Error reading Elo DB: ${e.message}`);
      }
      return;
    }

    // --------------------- !deluser <discordId> ---------------------
    if (message.content.startsWith("!deluser")) {
      const userId = args[0];
      if (!userId) {
        return message.reply("Usage: `!deluser <discordId>`");
      }

      try {
        const row = db
          .prepare("SELECT * FROM ratings WHERE player_id = ?")
          .get(userId);
        if (!row) return message.reply(`No record found for \`${userId}\`.`);

        const tx = db.transaction(() => {
          db.prepare("DELETE FROM ratings WHERE player_id = ?").run(userId);
          db.prepare("DELETE FROM rating_changes WHERE player_id = ?").run(userId);
        });
        tx();

        await message.reply(
          `✅ Deleted user \`${row.display_name}\` (${userId}) from Elo DB.`
        );
      } catch (e) {
        console.error("[!deluser error]", e);
        await message.reply(`Error deleting user: ${e.message}`);
      }
      return;
    }
  },
};
