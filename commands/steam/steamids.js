"use strict";

const { EmbedBuilder } = require("discord.js");
const { SteamLinks } = require("../../lib/steamLinks");
const steamLinks = new SteamLinks();

module.exports = {
  name: "steamids",
  description: "Show linked Steam IDs for a user",

  async execute(message, args = []) {
    try {
      let targetId;
      let targetName;

      if (message.mentions.users.size) {
        const user = message.mentions.users.first();
        targetId = user.id;
        targetName = user.username;
      } else if (args[0] && /^\d{17,20}$/.test(args[0])) {
        targetId = args[0];
        const player = await steamLinks.getPlayerName(targetId);
        targetName = player?.display_name ? `${player.display_name}` : targetId;
      } else {
        targetId = message.author.id;
        targetName = message.author.username;
      }

      const rows = await steamLinks.getSteamIds(targetId);

      const embed = new EmbedBuilder()
        .setTitle("Steam Links")
        .setColor(0x72d8ff)
        .setDescription(`**${targetName}**\n\`${targetId}\``)
        .setTimestamp();

      if (!rows.length) {
        embed.addFields({
          name: "Linked Steam IDs",
          value: "No Steam IDs linked.",
          inline: false
        });
      } else {
        embed.addFields({
          name: "Linked Steam IDs",
          value: rows.map(r => `\`${r.steam_id}\``).join("\n"),
          inline: false
        });
      }

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[steamids]", err);
      await message.channel.send("❌ Failed to retrieve Steam IDs.");
    }
  }
};