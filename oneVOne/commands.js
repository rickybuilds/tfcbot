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
      { name: "Match ID", value: `\`${challenge.id}\``, inline: false },
      { name: "Challenger", value: `<@${challenge.challengerId}>`, inline: true },
      { name: "Challenged", value: `<@${challenge.challengedId}>`, inline: true },
      { name: "Respond", value: "Use the buttons below to accept or deny. `!accept` and `!decline` also work.", inline: false },
      { name: "Time Remaining", value: `⏰ Expires <t:${expiresUnix}:R>`, inline: false },
    )
    .setFooter({ text: "NoNamePUG 1v1" })
    .setTimestamp();
}

function challengeButtons(challengeId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`1v1_accept_${challengeId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`1v1_deny_${challengeId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
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

  registry.set("test", async message => {
    const ownerId = String(message.author?.id || "");
    const testId = `${Date.now().toString(36)}_${ownerId}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`1v1_test_yes_${testId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`1v1_test_no_${testId}`)
        .setLabel("No")
        .setStyle(ButtonStyle.Danger),
    );
    const embed = noticeEmbed(COLORS.info, "Button Test", `<@${ownerId}>, select **Yes** or **No** below.`)
      .setFooter({ text: "This test expires after 30 seconds" });
    const testMessage = await message.channel.send({
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [ownerId] },
    });
    console.log(`[button-test] opened owner=${ownerId} message=${testMessage.id || "unknown"}`);
    const collector = testMessage.createMessageComponentCollector({
      time: 30_000,
      filter: interaction => String(interaction.customId || "").startsWith("1v1_test_"),
    });
    collector.on("collect", async interaction => {
      const userId = String(interaction.user?.id || "unknown");
      console.log(`[button-test] click received owner=${ownerId} user=${userId} customId=${interaction.customId}`);
      try {
        await interaction.deferUpdate();
        console.log(`[button-test] click acknowledged owner=${ownerId} user=${userId}`);
      } catch (error) {
        console.error(`[button-test] acknowledgement failed owner=${ownerId} user=${userId}`, error);
        return;
      }
      if (userId !== ownerId) {
        console.warn(`[button-test] click ignored reason=not_owner owner=${ownerId} user=${userId}`);
        await interaction.followUp({ content: "Only the person who ran `!test` can choose.", ephemeral: true }).catch(() => {});
        return;
      }
      const choice = String(interaction.customId).startsWith("1v1_test_yes_") ? "Yes" : "No";
      collector.stop("selected");
      await testMessage.edit({
        embeds: [successEmbed("✅ Button Test Passed", `<@${ownerId}> selected **${choice}**.`)],
        components: [],
        allowedMentions: { parse: [] },
      });
      console.log(`[button-test] completed owner=${ownerId} choice=${choice}`);
    });
    collector.on("end", async (_, reason) => {
      console.log(`[button-test] closed owner=${ownerId} reason=${reason || "unknown"}`);
      if (reason === "selected") return;
      await testMessage.edit({
        embeds: [noticeEmbed(COLORS.expired, "⌛ Button Test Expired", "No selection was received within 30 seconds.")],
        components: [],
      }).catch(() => {});
    });
    return testMessage;
  });

  registry.set("1v1", async message => {
    if (!inChannel(message)) return;
    const target = message.mentions?.users?.first();
    if (!target) return message.reply({ embeds: [deniedEmbed("Invalid 1v1 Challenge", "Usage: `!1v1 @user`")] });
    const result = manager.createChallenge(message.author, target);
    const errors = {
      self: "You cannot challenge yourself.", bot: "You cannot challenge a bot.",
      challenger_busy: "You are already committed to a pickup or 1v1 challenge.",
      challenged_busy: "That player is already committed to a pickup or 1v1 challenge.",
      id_generation_failed: "A match ID could not be allocated. Please try again.",
    };
    if (!result.ok) return message.reply({ embeds: [deniedEmbed("1v1 Challenge Denied", errors[result.reason] || "Challenge could not be created.")] });
    const challengeMessage = await message.channel.send({
      content: `<@${target.id}>`,
      embeds: [challengeEmbed(result.challenge)],
      components: [challengeButtons(result.challenge.id)],
      allowedMentions: { users: [String(target.id)] },
    });
    challengeMessages.set(result.challenge.id, challengeMessage);
    let challengeCollector;
    manager.onChallengeExpire(result.challenge.id, async challenge => {
      challengeCollector?.stop("expired");
      challengeMessages.delete(challenge.id);
      await challengeMessage.edit({
        content: "",
        embeds: [expiredChallengeEmbed(challenge)],
        components: [challengeButtons(challenge.id, true)],
        allowedMentions: { parse: [] },
      });
    });
    challengeCollector = challengeMessage.createMessageComponentCollector({
      time: Math.max(1, result.challenge.expiresAt - Date.now()),
    });
    console.log(`[1v1] - challenge buttons opened id=${result.challenge.id} message=${challengeMessage.id || "unknown"}`);
    challengeCollector.on("collect", async interaction => {
      const acceptId = `1v1_accept_${result.challenge.id}`;
      const denyId = `1v1_deny_${result.challenge.id}`;
      if (interaction.customId !== acceptId && interaction.customId !== denyId) return;
      const userId = String(interaction.user?.id || "unknown");
      console.log(`[1v1] - challenge button received id=${result.challenge.id} action=${interaction.customId === acceptId ? "accept" : "deny"} user=${userId}`);
      try {
        await interaction.deferUpdate();
        console.log(`[1v1] - challenge button acknowledged id=${result.challenge.id} user=${userId}`);
      } catch (error) {
        console.error(`[1v1] - challenge button acknowledgement failed id=${result.challenge.id} user=${userId}`, error);
        return;
      }

      try {
        if (userId !== String(result.challenge.challengedId)) {
          console.warn(`[1v1] - challenge button ignored id=${result.challenge.id} reason=ineligible user=${userId}`);
          return;
        }
        if (manager.incomingFor(userId)?.id !== result.challenge.id) {
          challengeCollector.stop("closed");
          await interaction.followUp({
            content: "This 1v1 challenge is no longer pending.",
            ephemeral: true,
          }).catch(() => {});
          return;
        }

        const interactionMessage = {
          author: interaction.user,
          channel: interaction.channel,
          reply: payload => interaction.followUp({ ...payload, ephemeral: true }),
        };
        if (interaction.customId === denyId) {
          challengeCollector.stop("denied");
          await registry.get("decline")(interactionMessage);
          return;
        }
        await registry.get("accept")(interactionMessage);
        if (result.challenge.status === "accepted") challengeCollector.stop("accepted");
      } catch (error) {
        console.error(`[1v1] - challenge button handler failed id=${result.challenge.id} action=${interaction.customId} user=${userId}`, error);
        await interaction.followUp({
          content: "The 1v1 button could not be processed. The error has been logged; try `!accept` or `!decline`.",
          ephemeral: true,
        }).catch(() => {});
      }
    });
    challengeCollector.on("end", (_, reason) => {
      console.log(`[1v1] - challenge buttons closed id=${result.challenge.id} reason=${reason || "unknown"}`);
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
    if (original) return original.edit({
      content: "",
      embeds: [embed],
      components: [challengeButtons(challenge.id, true)],
      allowedMentions: { parse: [] },
    });
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
        components: [challengeButtons(challenge.id, true)],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    const options = availableServers.slice(0, 5);
    const row = new ActionRowBuilder().addComponents(options.map((server, index) => new ButtonBuilder()
      .setCustomId(`1v1_server_${challenge.id}_${index}`)
      .setLabel(server.name)
      .setStyle(ButtonStyle.Primary)));
    const votes = new Map();
    const voterNames = new Map();
    const voteEndsUnix = Math.floor((Date.now() + 30_000) / 1000);

    function voteBreakdown({ includeStatus = true } = {}) {
      const lines = options.map((server, index) => {
        const names = [...votes.entries()]
          .filter(([, selected]) => selected === index)
          .map(([userId]) => `**${voterNames.get(userId) || "Unknown"}**`);
        const count = names.length;
        return `**${index + 1}. ${server.name}**\n${names.length ? `${names.join(", ")} — ` : ""}${count} vote${count === 1 ? "" : "s"}`;
      });
      if (includeStatus) {
        const waiting = [challenge.challengerId, challenge.challengedId].filter(id => !votes.has(String(id)));
        lines.push(`**Waiting on**\n${waiting.length ? waiting.map(id => `<@${id}>`).join(", ") : "✅ All eligible votes are in."}`);
        lines.push(`⏰ Voting ends <t:${voteEndsUnix}:R>`);
      }
      return lines.join("\n\n");
    }

    function connectionDetails(server) {
      const details = [
        `**Server:** ${server.name}`,
        `**IP:** \`${server.ip}\``,
      ];
      if (server.url) details.push(`[Click here to join the server](${server.url})`);
      return details.join("\n");
    }

    function preparingEmbed(server) {
      return successEmbed(
        "⚙️ Preparing 1v1 Server",
        `**Match ID:** ${challenge.id}\n\n**${server.name}** won the vote.\n\nChanging the server to **${config.map}** and applying the duel settings. The bot will ping both players when it is ready.\n\n${connectionDetails(server)}`,
      ).addFields({ name: "Final Votes", value: voteBreakdown({ includeStatus: false }) });
    }

    function readyEmbed(server) {
      return successEmbed(
        "⚔️ 1v1 Ready",
        `**Match ID:** ${challenge.id}\n\n<@${challenge.challengerId}> vs <@${challenge.challengedId}>\n\n${connectionDetails(server)}\n\n**Map:** ${config.map}\nBoth players can join now.`,
      ).setFooter({ text: `First to ${config.killGoal} kills` });
    }

    function cancelledEmbed(reason) {
      const descriptions = {
        setup_timeout: "The server did not confirm the duel map in time. It has been restored and released.",
        join_timeout: "The duel was cancelled because both players did not join in time. The server has been restored and released.",
        ready_timeout: "The duel was cancelled because both players were not ready in time. The server has been restored and released.",
        disconnect_timeout: "The duel was cancelled after a player remained disconnected past the grace period. The server has been restored and released.",
        admin_cancelled: "An admin cancelled the duel. The server has been restored and released.",
      };
      return noticeEmbed(COLORS.expired, "⌛ 1v1 Cancelled", descriptions[reason] || "The duel was cancelled and the server was released.");
    }

    function liveVoteEmbed() {
      return new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle("🗳️ 1v1 Server Vote")
        .setDescription(voteBreakdown())
        .setFooter({ text: "Both duelists vote • Ties are selected at random" })
        .setTimestamp();
    }

    const voteMessage = await message.channel.send({ embeds: [liveVoteEmbed()], components: [row] });
    const serverVotePrefix = `1v1_server_${challenge.id}_`;
    const collector = voteMessage.createMessageComponentCollector({
      time: 30_000,
      filter: interaction => String(interaction.customId || "").startsWith(serverVotePrefix),
    });
    collector.on("collect", async interaction => {
      // Acknowledge first so an unexpected payload or downstream edit cannot
      // leave Discord displaying the button's indefinite "..." loading state.
      try {
        await interaction.deferUpdate();
      } catch (error) {
        console.error(`[1v1] - failed to acknowledge server vote id=${challenge.id}`, error);
        return;
      }

      try {
        const userId = String(interaction.user?.id || "");
        if (![String(challenge.challengerId), String(challenge.challengedId)].includes(userId)) return;

        const index = Number(String(interaction.customId).slice(serverVotePrefix.length));
        if (!Number.isInteger(index) || index < 0 || index >= options.length) {
          console.warn(`[1v1] - invalid server vote ignored id=${challenge.id} user=${userId} customId=${interaction.customId}`);
          return;
        }
        votes.set(userId, index);
        voterNames.set(userId,
          interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || "Unknown");
        console.log(`[1v1] - server vote recorded id=${challenge.id} user=${userId} option=${options[index].name} votes=${votes.size}/2`);
        if (votes.size < 2) {
          await voteMessage.edit({ embeds: [liveVoteEmbed()], components: [row] });
          return;
        }
        const counts = new Map();
        for (const selected of votes.values()) counts.set(selected, (counts.get(selected) || 0) + 1);
        const max = Math.max(...counts.values());
        const tied = [...counts.entries()].filter(([, count]) => count === max).map(([selected]) => selected);
        const winningIndex = tied[Math.floor(Math.random() * tied.length)];
        const winner = options[winningIndex];
        collector.stop("selected");
        console.log(`[1v1] - server vote completed id=${challenge.id} winner=${winner.name} votes=${votes.size}`);

        const selectedEmbed = config.dryRun
          ? successEmbed("✅ Server Selected", `**${winner.name}** won the vote.\n\n🛡️ **DRY RUN:** No server commands were sent.`)
            .addFields({ name: "Final Votes", value: voteBreakdown({ includeStatus: false }) })
          : preparingEmbed(winner);
        await voteMessage.edit({ content: "", embeds: [selectedEmbed], components: [] }).catch(error => {
          console.error(`[1v1] - failed to show preparing state id=${challenge.id}`, error);
        });

        const activated = await manager.activate(challenge, winner, {
        onStatus: async status => {
          if (status.type === "ready") {
            await voteMessage.edit({
              content: `<@${challenge.challengerId}> <@${challenge.challengedId}> — your 1v1 server is ready.`,
              embeds: [readyEmbed(winner)],
              components: [],
              allowedMentions: { users: [String(challenge.challengerId), String(challenge.challengedId)] },
            });
            return;
          }
          if (status.type === "cancelled") {
            await voteMessage.edit({
              content: "",
              embeds: [cancelledEmbed(status.reason)],
              components: [],
              allowedMentions: { parse: [] },
            });
            return;
          }
          if (status.type === "failed") {
            const detail = status.reason === "restore_failed"
              ? "The duel could not continue, and automatic server restoration also failed. The server has been quarantined for an admin to inspect."
              : "The duel settings could not be applied after the map changed. The server has been quarantined for an admin to inspect.";
            await voteMessage.edit({
              content: "",
              embeds: [deniedEmbed("❌ 1v1 Setup Failed", detail)],
              components: [],
              allowedMentions: { parse: [] },
            });
          }
        },
        });
        if (!activated.ok) {
          manager.cancel(challenge.id, "activation_failed");
          console.error(`[1v1] - activation failed id=${challenge.id} server=${winner.name} reason=${activated.reason || "unavailable"}`);
          await voteMessage.edit({ content: "", embeds: [deniedEmbed("Server Reservation Failed", `The reservation failed (${activated.reason || "unavailable"}). Start the challenge again.`)], components: [] });
          return;
        }
        console.log(`[1v1] - activation accepted id=${challenge.id} server=${winner.name} waitingForMap=${!!activated.waitingForMap}`);
      } catch (error) {
        console.error(`[1v1] - server vote interaction failed id=${challenge.id}`, error);
      }
    });
    collector.on("end", async (_, reason) => {
      if (reason !== "selected") {
        manager.cancel(challenge.id, "vote_timeout");
        await voteMessage.edit({ content: "", embeds: [noticeEmbed(COLORS.expired, "⌛ Server Vote Expired", "The 1v1 server vote closed before both players voted.")], components: [] }).catch(() => {});
      }
    });
  });

  registry.set("1v1status", async message => {
    if (!inChannel(message)) return;
    const status = manager.status();
    const pending = status.pending.map(c => `<@${c.challengerId}> → <@${c.challengedId}>`).join("\n") || "None";
    const active = status.reservations.filter(r => r.mode === "1v1")
      .map(r => `${r.serverKey || r.serverIp}: ${r.status} (${r.id})`).join("\n") || "None";
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
    const id = target
      ? manager.pendingByPlayer.get(String(target.id)) || manager.activeByPlayer.get(String(target.id))
      : String(message.content || "").trim().split(/\s+/)[1];
    if (!id) return message.reply({ embeds: [deniedEmbed("Invalid Cancellation", "Usage: `!1v1cancel @user` or `!1v1cancel <challengeId>`")] });
    const cancelled = manager.cancel(id, "admin_cancelled");
    if (cancelled) return message.channel.send({ embeds: [successEmbed("1v1 Challenge Cancelled", `Cancelled challenge **${cancelled.id}**.`)] });
    const active = await manager.cancelActive(id, "admin_cancelled");
    if (!active.ok) return message.reply({ embeds: [deniedEmbed("Cancellation Failed", active.reason === "restore_failed" ? "Restoration failed; the server is quarantined and remains unavailable." : "No pending or active 1v1 was found.")] });
    return message.channel.send({ embeds: [successEmbed("Active 1v1 Cancelled", `Cancelled active 1v1 **${id}** and restored its server.`)] });
  });
}

module.exports = { registerCommands };
