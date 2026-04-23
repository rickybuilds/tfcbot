// commands/files.js
const { EmbedBuilder } = require("discord.js");
const { guardChannel } = require("../lib/guards");
const { NUM_SHORT, mirvLabel } = require("../lib/util");
const { loadServersFile, loadMappoolFile } = require("../lib/state");

function register(reg, { config, state }) {
  reg.set("servers", async (message) => {
    if (!(await guardChannel(message, config.PICKUP_CHANNEL_ID))) return;
    if (!state.servers.length) return message.channel.send("No servers configured. Please add to servers.json and `!reloadservers`.");
    const lines = state.servers.map((s, i) => `**${NUM_SHORT[i+1] || i+1}. ${s.name}** — ${s.ip}${s.password ? ` (pw: ${s.password})` : ""}`);
    await message.channel.send(lines.join("\n"));
  });

  reg.set("reloadservers", async (message) => {
    if (!(await guardChannel(message, config.PICKUP_CHANNEL_ID))) return;
    await message.channel.send(loadServersFile() ? "Servers reloaded." : "Failed to reload servers.json");
  });

  reg.set("maps", async (message) => {
    if (!(await guardChannel(message, config.PICKUP_CHANNEL_ID))) return;
    if (!state.maps.length) return message.channel.send("No maps loaded. Put maps in mappool.txt and `!reloadmaps`.");
    const lines = state.maps.slice(0, 50).map((m, i) => `**${NUM_SHORT[i+1] || i+1}. ${m.name}** — ${mirvLabel(m.tier)}${m.author ? ` — ${m.author}` : ""}`);
    await message.channel.send(lines.join("\n") + (state.maps.length > 50 ? `\n…and ${state.maps.length - 50} more` : ""));
  });

  reg.set("reloadmaps", async (message) => {
    if (!(await guardChannel(message, config.PICKUP_CHANNEL_ID))) return;
    await message.channel.send(loadMappoolFile() ? "Map pool reloaded." : "Failed to reload mappool.txt");
  });
}

module.exports = { register };
