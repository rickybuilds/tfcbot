"use strict";

const config = require("../config");
const { createInboxCard } = require("../services/trello");
const { EmbedBuilder } = require("discord.js");

const CATEGORIES = [
  { name: "Speedruns", aliases: ["speedrun", "speedruns", "sr"], labelEnv: "TRELLO_LABEL_SPEEDRUNS_ID" },
  { name: "Website", aliases: ["website", "web", "site"], labelEnv: "TRELLO_LABEL_WEBSITE_ID" },
  { name: "TFCBot", aliases: ["bot", "tfcbot", "discord"], labelEnv: "TRELLO_LABEL_TFCBOT_ID" },
  { name: "Database", aliases: ["db", "database", "sql"], labelEnv: "TRELLO_LABEL_DATABASE_ID" },
  { name: "Infrastructure", aliases: ["infra", "infrastructure", "server"], labelEnv: "TRELLO_LABEL_INFRASTRUCTURE_ID" },
  { name: "Analytics", aliases: ["analytics", "stats"], labelEnv: "TRELLO_LABEL_ANALYTICS_ID" },
  { name: "Community", aliases: ["community"], labelEnv: "TRELLO_LABEL_COMMUNITY_ID" },
  { name: "API", aliases: ["api", "endpoint", "endpoints"], labelEnv: "TRELLO_LABEL_API_ID" },
];

function parseIdea(args) {
  const firstWord = (args[0] || "").toLowerCase();
  const category = CATEGORIES.find((c) => c.aliases.includes(firstWord));

  if (category) {
    return {
      category: category.name,
      ideaText: args.slice(1).join(" ").trim(),
      labelIds: category.labelEnv && process.env[category.labelEnv]
        ? [process.env[category.labelEnv]]
        : [],
    };
  }

  return {
    category: "General",
    ideaText: args.join(" ").trim(),
    labelIds: [],
  };
}

function discordMessageUrl(message) {
  if (!message.guild?.id || !message.channel?.id || !message.id) {
    return "Unavailable";
  }

  return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
}

function formatCreatedAt(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

async function run(message, args) {
  const wantsChannelId = config.channels?.wants;

  if (wantsChannelId && message.channel?.id !== wantsChannelId) {
    return message.reply("💡 Please use <#1410076474014433392> for ideas and requests.");
  }

  const { category, ideaText, labelIds } = parseIdea(args);

  if (!ideaText) {
    return message.reply("Usage: `!idea [category] <your idea>`");
  }

  const createdBy =
    message.member?.displayName ||
    message.author?.username ||
    "Unknown";

  const cardTitle = `${category} – ${ideaText}`;

  const description = [
    `Category: ${category}`,
    "",
    ideaText,
    "",
    "---",
    "",
    `Created by: @${createdBy}`,
    `Created: ${formatCreatedAt()}`,
    "",
    "Original Discord Message:",
    discordMessageUrl(message),
    "",
    "---",
    "",
    "Status: Inbox",
  ].join("\n");

  const card = await createInboxCard({
    title: cardTitle,
    description,
    labelIds,
    });

  const auditChannel = message.client.channels.cache.get(config.channels.audit);

  if (auditChannel) {
    await auditChannel.send(
      `💡 ${message.author} submitted a new idea [${category}]: ${ideaText}`
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("💡 Trello Idea Created")
    .setURL(card.url)
    .addFields(
      { name: "Category", value: category, inline: true },
      { name: "Idea", value: ideaText.slice(0, 1024), inline: false }
    )
    .setTimestamp();

  return message.reply({ embeds: [embed] });
}

function register(registry, deps) {
  registry.set("idea", (m, a) => run(m, a, deps));
}

module.exports = { register };