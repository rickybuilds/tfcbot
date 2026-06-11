"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../../lib/guards");
const { SteamLinks, isValidSteamId } = require("../../lib/steamLinks");
const steamLinks = new SteamLinks();

module.exports = {
  name: "unlinksteam",
  description: "Remove a Steam ID link from a Discord user",

  async execute(message, args = []) {
    try {
      if (!isAdmin(message)) {
        return message.channel.send("❌ Admin only.");
      }

      const user = message.mentions.users.first();
      const discordId = user?.id || (args[0] && /^\d{17,20}$/.test(args[0]) ? args[0] : null);
      const steamId = user ? args[1] : args[1] || args[0];

      if (!discordId || !isValidSteamId(steamId)) {
        return message.channel.send("Usage: `!unlinksteam @user STEAM_0:1:12345` or `!unlinksteam DISCORD_ID STEAM_0:1:12345`");
      }

      const player = await steamLinks.getPlayerName(discordId);
      const displayName = user?.username || player?.display_name || discordId;

      const result = await steamLinks.unlinkSteam(discordId, steamId);

      const embed = new EmbedBuilder()
        .setTitle(result.changes ? "Steam Link Removed" : "Steam Link Not Found")
        .setColor(result.changes ? 0x72d8ff : 0xff5555)
        .addFields(
          { name: "Discord", value: `**${displayName}**\n\`${discordId}\``, inline: false },
          { name: "Steam ID", value: `\`${steamId}\``, inline: false }
        )
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[unlinksteam]", err);
      await message.channel.send("❌ Failed to unlink Steam ID.");
    }
  }
};
