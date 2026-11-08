"use strict";

const { EmbedBuilder } = require("discord.js");
const { licenseForDiscord } = require("../services/bootcampWatcher");
const { formatLevel, formatEndorsement } = require("../lib/bootcampLicense");

function siteUrl() {
  return String(process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/$/, "");
}

function register(registry, { pool, steamLinks }) {
  registry.set("bootcamp", async message => {
    const url = `${siteUrl()}/bootcamp.html`;
    await message.channel.send(`TFC Bootcamp: ${url}\nJoin the training server and use /tt_lessons to begin.`);
  });

  registry.set("license", async message => {
    try {
      const linked = (await steamLinks.getSteamIds(message.author.id)) || [];
      const embed = new EmbedBuilder().setColor(0x72d8ff).setTitle("TFC Bootcamp license");
      if (!linked.length) {
        embed.setDescription("No Steam ID is linked to your Discord account. Ask a bot admin to link it with `!linksteam @you STEAM_0:1:12345`, then use `!license` again.");
      } else {
        const license = await licenseForDiscord(pool, steamLinks, message.author.id, linked);
        const endorsements = license.endorsements.map(formatEndorsement);
        embed.setDescription([
          `**${formatLevel(license.level)}**`,
          endorsements.length ? `Endorsements: ${endorsements.join(", ")}` : "No endorsements yet.",
          `Steam IDs: ${linked.map(row => `\`${row.steam_id}\``).join(", ")}`,
        ].join("\n"));
        const profile = `${siteUrl()}/bootcamp-player.html?id=${encodeURIComponent(linked[0].steam_id)}`;
        embed.setURL(profile).setFooter({ text: "Training hub and detailed progress are available on your player profile." });
      }
      await message.channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[bootcamp license] lookup failed:", error);
      await message.channel.send("Could not load your Bootcamp license right now. Please try again shortly.");
    }
  });
}

module.exports = { register };
