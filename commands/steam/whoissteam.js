"use strict";

const { EmbedBuilder } = require("discord.js");
const { SteamLinks, isValidSteamId } = require("../../lib/steamLinks");
const steamLinks = new SteamLinks();

module.exports = {
  name: "whoissteam",
  description: "Find Discord user linked to a Steam ID",

  async execute(message, args = []) {
    try {
      const steamId = String(args[0] || "").trim();

      if (!isValidSteamId(steamId)) {
        return message.channel.send("Usage: `!whoissteam STEAM_0:1:12345`");
      }

      const rows = await steamLinks.getDiscordBySteam(steamId);

      const embed = new EmbedBuilder()
        .setTitle("Steam Lookup")
        .setColor(0x72d8ff)
        .setDescription(`\`${steamId}\``)
        .setTimestamp();

      if (!rows.length) {
        embed.addFields({
          name: "Linked Discord",
          value: "No Discord account linked.",
          inline: false
        });
      } else {
        embed.addFields({
          name: "Linked Discord",
          value: rows.map(r => `**${r.display_name || "Unknown"}**\n\`${r.discord_id}\``).join("\n\n"),
          inline: false
        });
      }

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[whoissteam]", err);
      await message.channel.send("❌ Failed to lookup Steam ID.");
    }
  }
};
