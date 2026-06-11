"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../../lib/guards");
const { SteamLinks } = require("../../lib/steamLinks");
const steamLinks = new SteamLinks();

module.exports = {
  name: "linkprogress",
  description: "Show Steam link progress",

  async execute(message) {
    try {
      if (!isAdmin(message)) {
        return message.channel.send("❌ Admin only.");
      }

      const p = await steamLinks.getLinkProgress();

      const discordPlayers = Number(p.discord_players || 0);
      const linkedPlayers = Number(p.linked_players || 0);
      const percent = discordPlayers
        ? ((linkedPlayers / discordPlayers) * 100).toFixed(1)
        : "0.0";

      const embed = new EmbedBuilder()
        .setTitle("Steam Link Progress")
        .setColor(0x72d8ff)
        .addFields(
          { name: "Discord Players", value: String(p.discord_players), inline: true },
          { name: "Linked Players", value: String(p.linked_players), inline: true },
          { name: "Missing Players", value: String(p.missing_players), inline: true },
          { name: "Unique Steam IDs", value: String(p.unique_steam_ids), inline: true },
          { name: "Total Links", value: String(p.total_links), inline: true },
          { name: "Progress", value: `${percent}%`, inline: true }
        )
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[linkprogress]", err);
      await message.channel.send("❌ Failed to get Steam link progress.");
    }
  }
};
