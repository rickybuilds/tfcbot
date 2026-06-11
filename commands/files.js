// commands/files.js
const { EmbedBuilder } = require("discord.js");
const { guardChannel } = require("../lib/guards");
const { NUM_SHORT, mirvLabel } = require("../lib/util");
const { loadServersFile, loadMappoolFile } = require("../lib/state");

function register(reg, { config, state }) {
reg.set("servers", async (message) => {
  if (!(await guardChannel(message, config.channels.pickup))) return;

  if (!state.servers.length) {
    return message.channel.send("No servers configured. Please add to servers.json and `!reloadservers`.");
  }

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle("NoName TFC Servers")
    .setDescription("Click a join link below or connect manually.")
    .setFooter({ text: "NN//TFC Pickups" });

  state.servers.forEach((s, i) => {
    embed.addFields({
      name: `${NUM_SHORT[i+1] || i+1}. ${s.name}`,
      value:
        `\`${s.ip}\`\n` +
        `${s.password ? `Password: \`${s.password}\`\n` : ""}` +
        `${s.url ? `🔗 ${s.url}` : ""}`,
      inline: false
    });
  });

  await message.channel.send({ embeds: [embed] });
});

  reg.set("reloadservers", async (message) => {
    if (!(await guardChannel(message, config.channels.pickup))) return;
    await message.channel.send(loadServersFile() ? "Servers reloaded." : "Failed to reload servers.json");
  });

  reg.set("reloadmaps", async (message) => {
    if (!(await guardChannel(message, config.channels.pickup))) return;
    await message.channel.send(loadMappoolFile() ? "Map pool reloaded." : "Failed to reload mappool.txt");
  });
}

module.exports = { register };
