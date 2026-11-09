"use strict";

const { EmbedBuilder } = require("discord.js");
const { licenseForDiscord } = require("../services/bootcampWatcher");
const { formatLevel, formatEndorsement, levelRank } = require("../lib/bootcampLicense");
const { challengesEnabled } = require("../services/bootcampChallenge");

function siteUrl() {
  return String(process.env.NONAME_URL || "https://nonamepickup.servehalflife.com").replace(/\/$/, "");
}
function accountLinkUrl() {
  const value = String(process.env.BOOTCAMP_ACCOUNT_LINK_URL || "").trim();
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch { return ""; }
}

async function handleLearningQueue(message, args, { api, steamLinks, config }) {
  const channelId = String(config?.channels?.learningQueue || "").trim();
  if (!config?.bootcampLearningQueueEnabled) {
    await message.channel.send("The learning-pug waitlist is not enabled.");
    return;
  }
  if (!channelId) {
    await message.channel.send("The learning-pug waitlist is not fully configured yet.");
    return;
  }
  if (String(message.channel?.id || "") !== channelId) {
    await message.channel.send(`Use the learning-pug waitlist in <#${channelId}>.`);
    return;
  }

  const action = String(args[0] || "").toLowerCase();
  if (action === "leave") {
    const removed = await steamLinks.leaveBootcampLearningQueue(message.author.id);
    await message.channel.send(removed.changes
      ? "You left the learning-pug waitlist."
      : "You are not on the learning-pug waitlist.");
    return;
  }

  if (action === "list" || action === "clear") {
    if (!isLearningQueueOrganizer(message, config)) {
      await message.channel.send("Only configured learning-pug organizers can manage the waitlist.");
      return;
    }
    if (action === "clear") {
      const result = await steamLinks.clearBootcampLearningQueue();
      await message.channel.send(`Learning-pug waitlist cleared (${Number(result.changes) || 0} signups removed).`);
      return;
    }
    const rows = await steamLinks.getBootcampLearningQueue();
    const lines = rows.slice(0, 32).map((row, index) =>
      `**${index + 1}.** <@${row.discord_id}>${row.display_name ? ` · ${String(row.display_name).slice(0, 48)}` : ""}`);
    await message.channel.send(rows.length
      ? `**Learning-pug waitlist (${rows.length})**\n${lines.join("\n")}${rows.length > lines.length ? `\n…and ${rows.length - lines.length} more.` : ""}`
      : "The learning-pug waitlist is empty.");
    return;
  }

  if (action === "status") {
    const rows = await steamLinks.getBootcampLearningQueue();
    const position = rows.findIndex(row => String(row.discord_id) === String(message.author.id));
    await message.channel.send(position >= 0
      ? `You are **${position + 1}/${rows.length}** on the learning-pug waitlist.`
      : "You are not on the learning-pug waitlist. Use `!learning join` to sign up.");
    return;
  }

  if (action !== "join") {
    await message.channel.send("Use `!learning join`, `!learning leave`, or `!learning status`. Organizers can use `!learning list` or `!learning clear`.");
    return;
  }

  const linked = (await steamLinks.getSteamIds(message.author.id)) || [];
  if (!linked.length) {
    const linkUrl = accountLinkUrl();
    await message.channel.send(linkUrl
      ? `Link Steam and Discord at ${linkUrl}, then use \`!learning join\` again.`
      : "Link a Steam ID with `!linksteam`, then use `!learning join` again.");
    return;
  }
  const license = await licenseForDiscord(api, steamLinks, message.author.id, linked);
  if (levelRank(license.level) < levelRank("permit")) {
    await message.channel.send("You need a Learner's permit before joining learning pugs. Complete a bronze map-tour quiz on the Bootcamp server first.");
    return;
  }

  const steamId = linked.find(row => Number(row.is_primary) === 1)?.steam_id || linked[0].steam_id;
  const before = await steamLinks.getBootcampLearningQueue();
  const existed = before.some(row => String(row.discord_id) === String(message.author.id));
  const size = Number(config.bootcampLearningQueueSize) || 8;
  const result = await steamLinks.joinBootcampLearningQueue(message.author.id, steamId, Math.floor(Date.now() / 1000), size);
  const rows = await steamLinks.getBootcampLearningQueue();
  const position = rows.findIndex(row => String(row.discord_id) === String(message.author.id));
  if (position < 0) {
    await message.channel.send("The learning-pug waitlist is full. Please try again after an organizer schedules a session.");
    return;
  }
  await message.channel.send(`You're **${position + 1}/${size}** on the learning-pug waitlist. An organizer will post when a session is scheduled.`);
  if (!existed && Number(result.changes) === 1 && before.length < size && rows.length >= size) {
    const roleId = String(config.roles?.bootcampLearningOrganizer || "").trim();
    await message.channel.send(`${roleId ? `<@&${roleId}> ` : ""}The learning-pug waitlist reached ${size} players and is ready for an organizer to schedule.`);
  }
}

function isLearningQueueOrganizer(message, config) {
  const roles = message.member?.roles?.cache;
  const adminRole = String(config.roles?.admin || "").trim();
  const organizerRole = String(config.roles?.bootcampLearningOrganizer || "").trim();
  return Boolean(roles?.has && ((adminRole && roles.has(adminRole)) || (organizerRole && roles.has(organizerRole))));
}

function register(registry, { api, steamLinks, config = {} }) {
  registry.set("bootcamp", async message => {
    const url = `${siteUrl()}/bootcamp.html`;
    await message.channel.send(`TFC Bootcamp: ${url}\nJoin the training server and use /tt_lessons to begin.`);
  });

  registry.set("license", async message => {
    try {
      const linked = (await steamLinks.getSteamIds(message.author.id)) || [];
      const embed = new EmbedBuilder().setColor(0x72d8ff).setTitle("TFC Bootcamp license");
      if (!linked.length) {
        const linkUrl = accountLinkUrl();
        embed.setDescription(linkUrl
          ? `No Steam ID is linked to your Discord account. [Link Steam and Discord](${linkUrl}), then use \`!license\` again.`
          : "No Steam ID is linked to your Discord account. Ask a bot admin to link it with `!linksteam @you STEAM_0:1:12345`, then use `!license` again.");
      } else {
        const license = await licenseForDiscord(api, steamLinks, message.author.id, linked);
        const endorsements = license.endorsements.map(formatEndorsement);
        embed.setDescription([
          `**${formatLevel(license.level)}**`,
          endorsements.length ? `Endorsements: ${endorsements.join(", ")}` : "No endorsements yet.",
          license.cosignedBy ? `Mentor co-sign: <@${license.cosignedBy}>` : null,
          `Steam IDs: ${linked.map(row => `\`${row.steam_id}\``).join(", ")}`,
        ].filter(Boolean).join("\n"));
        const profile = `${siteUrl()}/bootcamp.html?steamid=${encodeURIComponent(linked[0].steam_id)}`;
        embed.setURL(profile).setFooter({ text: "Training hub and detailed progress are available on your player profile." });
      }
      await message.channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[bootcamp license] lookup failed:", error);
      await message.channel.send("Could not load your Bootcamp license right now. Please try again shortly.");
    }
  });

  registry.set("learning", async (message, args = []) => {
    if (["join", "leave", "status", "list", "clear"].includes(String(args[0] || "").toLowerCase())) {
      try { await handleLearningQueue(message, args, { api, steamLinks, config }); }
      catch (error) {
        console.error("[bootcamp learning queue] operation failed:", error);
        await message.channel.send("Could not update the learning-pug waitlist right now. Please try again shortly.");
      }
      return;
    }
    if (String(process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED || "").trim().toLowerCase() !== "true") {
      await message.channel.send("Learning-pug eligibility checks are not enabled.");
      return;
    }
    try {
      const linked = (await steamLinks.getSteamIds(message.author.id)) || [];
      if (!linked.length) {
        const linkUrl = accountLinkUrl();
        await message.channel.send(linkUrl
          ? `Link Steam and Discord at ${linkUrl}, then use \`!learning\` to check permit eligibility.`
          : "Link a Steam ID with `!linksteam`, then use `!learning` to check permit eligibility.");
        return;
      }
      const license = await licenseForDiscord(api, steamLinks, message.author.id, linked);
      if (levelRank(license.level) >= levelRank("permit")) {
        await message.channel.send("You have a Learner's permit and are eligible for learning pugs. Ask an organizer for the next session.");
      } else {
        await message.channel.send("You need a Learner's permit for learning pugs. Complete a bronze map-tour quiz on the Bootcamp server, then use `!learning` again.");
      }
    } catch (error) {
      console.error("[bootcamp learning eligibility] lookup failed:", error);
      await message.channel.send("Could not verify learning-pug eligibility right now. Please try again shortly.");
    }
  });

  registry.set("cosign", async message => {
    if (!config?.bootcampMentorCosignEnabled || !config.roles?.bootcampMentor) {
      await message.channel.send("Mentor co-signs are not enabled.");
      return;
    }
    if (!message.member?.roles?.cache?.has(config.roles.bootcampMentor)) {
      await message.channel.send("Only members with the configured Bootcamp mentor role can co-sign.");
      return;
    }
    const target = message.mentions?.users?.first?.();
    if (!target) {
      await message.channel.send("Usage: `!cosign @player` after watching them in a learning pug.");
      return;
    }
    if (target.id === message.author.id) {
      await message.channel.send("You cannot co-sign yourself.");
      return;
    }
    try {
      const linked = (await steamLinks.getSteamIds(target.id)) || [];
      const primary = linked.find(row => Number(row.is_primary) === 1) || linked[0];
      if (!primary?.steam_id) {
        await message.channel.send("That player needs to link a Steam ID before a mentor co-sign.");
        return;
      }
      await api.cosignLicense(primary.steam_id, message.author.id);
      await message.channel.send(`Mentor co-sign recorded for <@${target.id}>.`);
    } catch (error) {
      if (Number(error.response?.status) === 409) {
        await message.channel.send("That license already has a co-sign from another mentor.");
        return;
      }
      console.error("[bootcamp cosign] request failed:", error);
      await message.channel.send("Could not record the Bootcamp co-sign right now. Please try again shortly.");
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

  registry.set("season", async message => {
    if (String(process.env.BOOTCAMP_SEASONS_ENABLED || "").trim().toLowerCase() !== "true") {
      await message.channel.send("Bootcamp season standings are not enabled.");
      return;
    }
    try {
      const { season, standings = [] } = await api.season();
      if (!season) {
        await message.channel.send("There is no active Bootcamp season right now.");
        return;
      }
      const rows = standings.slice(0, 10).map(row =>
        `**${row.rank}.** ${row.playerName || row.steamId} · ${Number(row.points)} points · ${Number(row.objectives)} objectives`);
      const embed = new EmbedBuilder().setColor(0x72d8ff).setTitle(`TFC Bootcamp season — ${season.title}`)
        .setDescription(rows.length ? rows.join("\n") : "No tier improvements have been recorded this season yet.")
        .setFooter({ text: `${season.startsAt.slice(0, 10)} to ${season.endsAt.slice(0, 10)} UTC` });
      await message.channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("[bootcamp season] lookup failed:", error);
      await message.channel.send("Could not load Bootcamp season standings right now. Please try again shortly.");
    }
  });
}

module.exports = { register };
