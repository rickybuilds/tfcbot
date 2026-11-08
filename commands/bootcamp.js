"use strict";

const { EmbedBuilder } = require("discord.js");
const { licenseForDiscord } = require("../services/bootcampWatcher");
const { formatLevel, formatEndorsement } = require("../lib/bootcampLicense");
const { challengesEnabled } = require("../services/bootcampChallenge");

function siteUrl() {
  return String(process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/$/, "");
}

function register(registry, { api, steamLinks }) {
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
        const license = await licenseForDiscord(api, steamLinks, message.author.id, linked);
        const endorsements = license.endorsements.map(formatEndorsement);
        embed.setDescription([
          `**${formatLevel(license.level)}**`,
          endorsements.length ? `Endorsements: ${endorsements.join(", ")}` : "No endorsements yet.",
          `Steam IDs: ${linked.map(row => `\`${row.steam_id}\``).join(", ")}`,
        ].join("\n"));
        const profile = `${siteUrl()}/bootcamp.html?steamid=${encodeURIComponent(linked[0].steam_id)}`;
        embed.setURL(profile).setFooter({ text: "Training hub and detailed progress are available on your player profile." });
      }
      await message.channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[bootcamp license] lookup failed:", error);
      await message.channel.send("Could not load your Bootcamp license right now. Please try again shortly.");
    }
  });

  registry.set("challenge", async message => {
    if (!challengesEnabled()) {
      await message.channel.send("Weekly Bootcamp challenges are not enabled.");
      return;
    }
    try {
      const { challenge, standings } = await api.challenge();
      if (!challenge) {
        await message.channel.send("There is no active Bootcamp challenge this week.");
        return;
      }
      const rows = standings.slice(0, 10).map((row, index) => {
        const result = challenge.targetType === "route" ? `${(Number(row.timeMs) / 1000).toFixed(3)}s` : `${Number(row.score).toFixed(2)} pts`;
        return `**${index + 1}.** ${row.playerName || row.steamId} · class ${row.classId} — ${result}`;
      });
      const embed = new EmbedBuilder().setColor(0x72d8ff).setTitle("Weekly TFC Bootcamp Challenge")
        .setDescription([`**${challenge.title}**`, `${challenge.map} · ${challenge.targetName} · ${challenge.targetType === "route" ? "Fastest valid run wins" : "Highest published score wins"}`,
          "", ...(rows.length ? rows : ["No eligible results yet."])].join("\n"));
      await message.channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[bootcamp challenge] lookup failed:", error);
      await message.channel.send("Could not load the Bootcamp challenge right now. Please try again shortly.");
    }
  });
}

module.exports = { register };
