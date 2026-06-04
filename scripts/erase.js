// scripts/erase.js
"use strict";

module.exports = {
  name: "erase",
  description: "Erase the last N messages in a channel",
  async execute(message, args) {
    if (!args[0]) {
      return message.reply("Usage: !erase <count> <channelId|here>");
    }

    const count = parseInt(args[0], 10);
    if (isNaN(count) || count < 1 || count > 1000) {
      return message.reply("⚠️ Please provide a valid number between 1 and 1000.");
    }

    const channelId = args[1] === "here" || !args[1] ? message.channel.id : args[1];
    const channel = await message.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return message.reply("⚠️ Invalid channel ID.");
    }

    let deletedCount = 0;
    let remaining = count;
    let lastId = null;

    while (remaining > 0) {
      const batchSize = Math.min(remaining, 100);
      const options = { limit: batchSize };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      try {
        await channel.bulkDelete(messages, true);
        deletedCount += messages.size;
        remaining -= messages.size;
      } catch (e) {
        console.error("bulkDelete error:", e);
        break;
      }

      lastId = messages.last()?.id;
      if (messages.size < batchSize) break;
    }

    return message.reply(
      `✅ Deleted ${deletedCount} messages in <#${channel.id}>.`
    );
  },
};
