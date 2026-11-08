const axios = require("axios");
const { EmbedBuilder, escapeMarkdown } = require("discord.js");

const API_URL = "http://137.184.215.22:4000/api/queue";
const MARKER = "Aron PUGs queue";
const TITLE_PREFIX = "Aron PUGs Player Queue — (";

function createAronQueueWatcher({ client, channelId, fetchQueue = async () => {
  const response = await axios.get(API_URL, { timeout: 10000 });
  return response.data;
}, logger = console }) {
  let board = null;
  let checkedHistory = false;
  let lastContent = null;
  let running = false;

  async function poll() {
    if (running || !channelId) return;
    running = true;
    try {
      const queue = await fetchQueue();
      if (!queue || queue.ok !== true || !Array.isArray(queue.players) ||
          !Number.isInteger(queue.count) || queue.count !== queue.players.length ||
          !Number.isInteger(queue.max) || queue.max < 1 ||
          queue.players.some(player => typeof player?.name !== "string")) {
        throw new Error("Invalid queue API response");
      }
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== "function") throw new Error("Queue channel is unavailable");
      if (!checkedHistory) {
        const messages = await channel.messages.fetch({ limit: 100 });
        board = messages.find(message => message.author?.id === client.user.id &&
          message.embeds?.some(embed => embed.footer?.text === MARKER || embed.title?.startsWith(TITLE_PREFIX))) || null;
        checkedHistory = true;
      }
      const content = JSON.stringify({ count: queue.count, max: queue.max, players: queue.players });
      if (content === lastContent) return;
      const names = queue.players.map(player => escapeMarkdown(player.name.replace(/[\r\n]/g, " ").slice(0, 100)));
      const updatedAt = new Date();
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`${TITLE_PREFIX}${queue.count}/${queue.max})`)
        .setDescription((names.join("\n") || "_empty_").slice(0, 4000))
        .addFields(
          { name: "Join Aron PUGs", value: "https://discord.gg/udNgzWfDWa" },
          { name: "Last updated", value: `<t:${Math.floor(updatedAt.getTime() / 1000)}:D> at <t:${Math.floor(updatedAt.getTime() / 1000)}:T>` }
        );
      const payload = { embeds: [embed], allowedMentions: { parse: [] } };
      if (board) {
        try { await board.edit(payload); }
        catch (error) {
          if (error.code !== 10008) throw error;
          board = null;
          board = await channel.send(payload);
        }
      } else {
        board = await channel.send(payload);
      }
      lastContent = content;
    } catch (error) {
      logger.error?.("[aronQueueWatcher] poll failed:", error.message);
    } finally {
      running = false;
    }
  }
  return { poll };
}

function startAronQueueWatcher({ client, channelId, logger = console }) {
  if (!channelId) return;
  const watcher = createAronQueueWatcher({ client, channelId, logger });
  void watcher.poll();
  return setInterval(() => void watcher.poll(), 30000);
}

module.exports = { createAronQueueWatcher, startAronQueueWatcher };
