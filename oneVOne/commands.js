"use strict";

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

function registerCommands(registry, { config, manager }) {
  const inChannel = message => !config.channelId || String(message.channel?.id) === config.channelId;

  registry.set("1v1", async message => {
    if (!inChannel(message)) return;
    const target = message.mentions?.users?.first();
    if (!target) return message.reply("Usage: `!1v1 @user`");
    const result = manager.createChallenge(message.author, target);
    const errors = {
      self: "You cannot challenge yourself.", bot: "You cannot challenge a bot.",
      challenger_busy: "You are already committed to a pickup or 1v1 challenge.",
      challenged_busy: "That player is already committed to a pickup or 1v1 challenge.",
    };
    if (!result.ok) return message.reply(`❌ ${errors[result.reason] || "Challenge could not be created."}`);
    const seconds = Math.ceil(config.challengeTtlMs / 1000);
    return message.channel.send(`⚔️ <@${target.id}>, <@${message.author.id}> challenged you to a 1v1. Use \`!accept\` or \`!decline\` within **${seconds}s**.`);
  });

  registry.set("decline", async message => {
    if (!inChannel(message)) return;
    const challenge = manager.incomingFor(message.author.id);
    if (!challenge) return message.reply("You do not have a pending incoming 1v1 challenge.");
    manager.cancel(challenge.id, "declined");
    return message.channel.send(`❌ <@${message.author.id}> declined <@${challenge.challengerId}>'s 1v1 challenge.`);
  });

  registry.set("accept", async message => {
    if (!inChannel(message)) return;
    const result = await manager.accept(message.author.id);
    if (!result.ok) {
      const errors = {
        not_found: "You do not have a pending incoming 1v1 challenge.", expired: "That challenge expired.",
        pickup_locked: "One of the players is now committed to an active pickup.",
        steam_link: "Both players need one unambiguous primary SteamID.", no_servers: "No servers are currently available.",
      };
      return message.reply(`❌ ${errors[result.reason] || "The challenge could not be accepted."}`);
    }
    const { challenge, availableServers } = result;
    const options = availableServers.slice(0, 5);
    const row = new ActionRowBuilder().addComponents(options.map((server, index) => new ButtonBuilder()
      .setCustomId(`1v1_server_${challenge.id}_${index}`)
      .setLabel(server.name)
      .setStyle(ButtonStyle.Primary)));
    const embed = new EmbedBuilder().setTitle("1v1 Server Vote")
      .setDescription(`<@${challenge.challengerId}> and <@${challenge.challengedId}>: choose a server. First vote wins during the dry-run milestone.`);
    const voteMessage = await message.channel.send({ embeds: [embed], components: [row] });
    const collector = voteMessage.createMessageComponentCollector({ time: 30_000 });
    const votes = new Map();
    collector.on("collect", async interaction => {
      if (![challenge.challengerId, challenge.challengedId].includes(String(interaction.user.id))) {
        return interaction.reply({ content: "Only the two duel players can vote.", ephemeral: true });
      }
      const index = Number(interaction.customId.split("_").pop());
      const server = options[index];
      votes.set(String(interaction.user.id), index);
      await interaction.reply({ content: `Vote recorded for **${server.name}**.`, ephemeral: true });
      if (votes.size < 2) return;
      const counts = new Map();
      for (const selected of votes.values()) counts.set(selected, (counts.get(selected) || 0) + 1);
      const max = Math.max(...counts.values());
      const tied = [...counts.entries()].filter(([, count]) => count === max).map(([selected]) => selected);
      const winningIndex = tied[Math.floor(Math.random() * tied.length)];
      const winner = options[winningIndex];
      const activated = manager.activate(challenge, winner);
      if (!activated.ok) {
        collector.stop("unavailable");
        return voteMessage.edit({ content: `The reservation failed (${activated.reason || "unavailable"}). Start the challenge again.`, embeds: [], components: [] });
      }
      collector.stop("selected");
      const safety = config.dryRun ? " **DRY RUN:** no server commands were sent." : "";
      return voteMessage.edit({ content: `✅ **${winner.name}** won the vote.${safety}`, embeds: [], components: [] });
    });
    collector.on("end", async (_, reason) => {
      if (reason !== "selected" && reason !== "unavailable") {
        manager.cancel(challenge.id, "vote_timeout");
        await voteMessage.edit({ content: "⌛ 1v1 server vote expired.", embeds: [], components: [] }).catch(() => {});
      }
    });
  });
}

module.exports = { registerCommands };
