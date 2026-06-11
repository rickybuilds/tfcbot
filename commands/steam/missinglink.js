"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../../lib/guards");
const { SteamLinks } = require("../../lib/steamLinks");
const steamLinks = new SteamLinks();

module.exports = {
  name: "missinglink",
  description: "Show rated players missing Steam links",

  async execute(message, args = []) {
    try {
      if (!isAdmin(message)) {
        return message.channel.send("❌ Admin only.");
      }

      const limit = Math.min(Math.max(parseInt(args[0] || "25", 10) || 25, 1), 50);
      const rows = await steamLinks.getMissingLinks(limit);

      const embed = new EmbedBuilder()
        .setTitle("Missing Steam Links")
        .setColor(0x72d8ff)
        .setDescription(`Showing top ${rows.length} by Elo`)
        .setTimestamp();

      if (!rows.length) {
        embed.addFields({
          name: "Status",
          value: "All rated players have Steam links.",
          inline: false
        });
      } else {
        embed.addFields({
          name: "Players",
          value: rows.map(r => `**${r.display_name}** — ${r.rating}\n\`${r.discord_id}\``).join("\n\n").slice(0, 3900),
          inline: false
        });
      }

      await message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[missinglink]", err);
      await message.channel.send("❌ Failed to retrieve missing Steam links.");
    }
  }
};
