"use strict";

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

const COLORS = Object.freeze({
  challenge: 0xfaa61a,
  expired: 0x747f8d,
  denied: 0xed4245,
  success: 0x57f287,
  info: 0x5865f2,
  status: 0x8b5cf6,
});

function noticeEmbed(color, title, description) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

const deniedEmbed = (title, description) => noticeEmbed(COLORS.denied, title, description);
const successEmbed = (title, description) => noticeEmbed(COLORS.success, title, description);

function challengeEmbed(challenge) {
  const expiresUnix = Math.floor(challenge.expiresAt / 1000);
  return new EmbedBuilder()
    .setColor(COLORS.challenge)
    .setTitle("⚔️ 1v1 Challenge")
    .setDescription(`<@${challenge.challengedId}>, you have been challenged to a head-to-head duel.`)
    .addFields(
      { name: "Challenger", value: `<@${challenge.challengerId}>`, inline: true },
      { name: "Challenged", value: `<@${challenge.challengedId}>`, inline: true },
      { name: "Respond", value: "Use `!accept` or `!decline` in this channel.", inline: false },
      { name: "Time Remaining", value: `⏰ Expires <t:${expiresUnix}:R>`, inline: false },
    )
    .setFooter({ text: "NoNamePUG 1v1" })
    .setTimestamp();
}

function expiredChallengeEmbed(challenge) {
  return new EmbedBuilder()
    .setColor(COLORS.expired)
    .setTitle("⌛ 1v1 Challenge Expired")
    .setDescription(`The challenge between <@${challenge.challengerId}> and <@${challenge.challengedId}> was not accepted in time.`)
    .setFooter({ text: "No match was created" })
    .setTimestamp();
}

function registerCommands(registry, { config, manager, adminRoleId }) {
  const inChannel = message => !config.channelId || String(message.channel?.id) === config.channelId;
  const challengeMessages = new Map();

  registry.set("1v1", async message => {
    if (!inChannel(message)) return;
    const target = message.mentions?.users?.first();
    if (!target) return message.reply({ embeds: [deniedEmbed("Invalid 1v1 Challenge", "Usage: `!1v1 @user`")] });
    const result = manager.createChallenge(message.author, target);
    const errors = {
      self: "You cannot challenge yourself.", bot: "You cannot challenge a bot.",
      challenger_busy: "You are already committed to a pickup or 1v1 challenge.",
      challenged_busy: "That player is already committed to a pickup or 1v1 challenge.",
    };
    if (!result.ok) return message.reply({ embeds: [deniedEmbed("1v1 Challenge Denied", errors[result.reason] || "Challenge could not be created.")] });
    const challengeMessage = await message.channel.send({
      content: `<@${target.id}>`,
      embeds: [challengeEmbed(result.challenge)],
      allowedMentions: { users: [String(target.id)] },
    });
    challengeMessages.set(result.challenge.id, challengeMessage);
    manager.onChallengeExpire(result.challenge.id, async challenge => {
      challengeMessages.delete(challenge.id);
      await challengeMessage.edit({
        content: "",
        embeds: [expiredChallengeEmbed(challenge)],
        allowedMentions: { parse: [] },
      });
    });
    return challengeMessage;
  });

  registry.set("decline", async message => {
    if (!inChannel(message)) return;
    const challenge = manager.incomingFor(message.author.id);
    if (!challenge) return message.reply({ embeds: [deniedEmbed("Decline Denied", "You do not have a pending incoming 1v1 challenge.")] });
    manager.cancel(challenge.id, "declined");
    const original = challengeMessages.get(challenge.id);
    challengeMessages.delete(challenge.id);
    const embed = deniedEmbed(
      "❌ 1v1 Challenge Declined",
      `<@${challenge.challengedId}> declined the challenge from <@${challenge.challengerId}>.`,
    ).setFooter({ text: "No match was created" });
    if (original) return original.edit({ content: "", embeds: [embed], allowedMentions: { parse: [] } });
    return message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
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
      return message.reply({ embeds: [deniedEmbed("1v1 Acceptance Denied", errors[result.reason] || "The challenge could not be accepted.")] });
    }
    const { challenge, availableServers } = result;
    const original = challengeMessages.get(challenge.id);
    challengeMessages.delete(challenge.id);
    if (original) {
      await original.edit({
        content: "",
        embeds: [successEmbed("✅ 1v1 Challenge Accepted", `<@${challenge.challengedId}> accepted <@${challenge.challengerId}>'s challenge.`)],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    const options = availableServers.slice(0, 5);
    const row = new ActionRowBuilder().addComponents(options.map((server, index) => new ButtonBuilder()
      .setCustomId(`1v1_server_${challenge.id}_${index}`)
      .setLabel(server.name)
      .setStyle(ButtonStyle.Primary)));
    const voteEndsUnix = Math.floor((Date.now() + 30_000) / 1000);
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle("🗳️ 1v1 Server Vote")
      .setDescription(`<@${challenge.challengerId}> and <@${challenge.challengedId}>, choose a server below.`)
      .addFields(
        { name: "Voting", value: "Both duelists vote. A tied result is selected at random." },
        { name: "Time Remaining", value: `⏰ Voting ends <t:${voteEndsUnix}:R>` },
      )
      .setFooter({ text: "NoNamePUG 1v1" })
      .setTimestamp();
    const voteMessage = await message.channel.send({ embeds: [embed], components: [row] });
    const collector = voteMessage.createMessageComponentCollector({ time: 30_000 });
    const votes = new Map();
    collector.on("collect", async interaction => {
      if (![challenge.challengerId, challenge.challengedId].includes(String(interaction.user.id))) {
        return interaction.reply({ embeds: [deniedEmbed("Vote Denied", "Only the two duelists can vote.")], ephemeral: true });
      }
      const index = Number(interaction.customId.split("_").pop());
      const server = options[index];
      votes.set(String(interaction.user.id), index);
      await interaction.reply({ embeds: [successEmbed("Vote Recorded", `Your vote for **${server.name}** has been recorded.`)], ephemeral: true });
      if (votes.size < 2) return;
      const counts = new Map();
      for (const selected of votes.values()) counts.set(selected, (counts.get(selected) || 0) + 1);
      const max = Math.max(...counts.values());
      const tied = [...counts.entries()].filter(([, count]) => count === max).map(([selected]) => selected);
      const winningIndex = tied[Math.floor(Math.random() * tied.length)];
      const winner = options[winningIndex];
      const activated = await manager.activate(challenge, winner);
      if (!activated.ok) {
        collector.stop("unavailable");
        return voteMessage.edit({ content: "", embeds: [deniedEmbed("Server Reservation Failed", `The reservation failed (${activated.reason || "unavailable"}). Start the challenge again.`)], components: [] });
      }
      collector.stop("selected");
      const safety = config.dryRun ? "\n\n🛡️ **DRY RUN:** No server commands were sent." : "";
      return voteMessage.edit({ content: "", embeds: [successEmbed("✅ Server Selected", `**${winner.name}** won the vote.${safety}`)], components: [] });
    });
    collector.on("end", async (_, reason) => {
      if (reason !== "selected" && reason !== "unavailable") {
        manager.cancel(challenge.id, "vote_timeout");
        await voteMessage.edit({ content: "", embeds: [noticeEmbed(COLORS.expired, "⌛ Server Vote Expired", "The 1v1 server vote closed before both players voted.")], components: [] }).catch(() => {});
      }
    });
  });

  registry.set("1v1status", async message => {
    if (!inChannel(message)) return;
    const status = manager.status();
    const pending = status.pending.map(c => `<@${c.challengerId}> → <@${c.challengedId}>`).join("\n") || "None";
    const active = status.reservations.filter(r => r.mode === "1v1").map(r => `${r.serverKey || r.serverIp}: ${r.status}`).join("\n") || "None";
    const embed = new EmbedBuilder().setColor(COLORS.status).setTitle("⚔️ 1v1 Status")
      .addFields(
        { name: "Pending Challenges", value: pending },
        { name: "Active Reservations", value: active },
      ).setTimestamp();
    return message.channel.send({ embeds: [embed] });
  });

  registry.set("1v1cancel", async message => {
    const isAdmin = adminRoleId && message.member?.roles?.cache?.has(adminRoleId);
    if (!isAdmin) return message.reply({ embeds: [deniedEmbed("Cancellation Denied", "You do not have permission to cancel active 1v1s.")] });
    const target = message.mentions?.users?.first();
    const id = target ? manager.pendingByPlayer.get(String(target.id)) : String(message.content || "").trim().split(/\s+/)[1];
    if (!id) return message.reply({ embeds: [deniedEmbed("Invalid Cancellation", "Usage: `!1v1cancel @user` or `!1v1cancel <challengeId>`")] });
    const cancelled = manager.cancel(id, "admin_cancelled");
    if (cancelled) return message.channel.send({ embeds: [successEmbed("1v1 Challenge Cancelled", `Cancelled challenge **${cancelled.id}**.`)] });
    const active = await manager.cancelActive(id, "admin_cancelled");
    if (!active.ok) return message.reply({ embeds: [deniedEmbed("Cancellation Failed", active.reason === "restore_failed" ? "Restoration failed; the server is quarantined and remains unavailable." : "No pending or active 1v1 was found.")] });
    return message.channel.send({ embeds: [successEmbed("Active 1v1 Cancelled", `Cancelled active 1v1 **${id}** and restored its server.`)] });
  });
}

module.exports = { registerCommands };
