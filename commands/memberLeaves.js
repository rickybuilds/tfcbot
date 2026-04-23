// commands/memberLeaves.js
"use strict";

const { EmbedBuilder } = require("discord.js");

/**
 * Logs when members leave the guild to the configured audit channel.
 * Uses config.channels.audit for target channel.
 */
function register(client, config) {
  client.on("guildMemberRemove", async (member) => {
    try {
      const auditId = config.channels?.audit;
      if (!auditId) return console.warn("[memberLeaves] Missing config.channels.audit");

      const channel = await member.guild.channels.fetch(auditId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;

      const user = member.user;
      const joinedAt = member.joinedAt ? member.joinedAt.getTime() : null;
      const leftAt = Date.now();

      // Build readable info
      const joinedAgo = joinedAt
        ? `<t:${Math.floor(joinedAt / 1000)}:R>` // “joined 2 months ago”
        : "unknown";

      const joinedDate = joinedAt
        ? `<t:${Math.floor(joinedAt / 1000)}:f>` // “Jun 2, 2025 3:00 PM”
        : "unknown";

      const leftDate = `<t:${Math.floor(leftAt / 1000)}:f>`;

      // Duration
      let stayedDays = "";
      if (joinedAt) {
        const diffDays = Math.floor((leftAt - joinedAt) / (1000 * 60 * 60 * 24));
        stayedDays = diffDays >= 1 ? `${diffDays} day${diffDays === 1 ? "" : "s"}` : "<1 day";
      }

      // Create embed
      const emb = new EmbedBuilder()
        .setColor(0xed4245)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setTitle("🚪 Member Left Server")
        .setDescription(`<@${user.id}> (${user.id})`)
        .addFields(
          { name: "Joined", value: `${joinedDate} (${joinedAgo})`, inline: true },
          { name: "Left", value: leftDate, inline: true },
          { name: "Stayed", value: stayedDays || "unknown", inline: true }
        )
        .setTimestamp();

      await channel.send({ embeds: [emb] });
      console.log(`[audit] ${user.tag} left ${member.guild.name} (joined ${joinedAgo}, stayed ${stayedDays})`);
    } catch (err) {
      console.error("[memberLeaves] Error logging leave:", err);
    }
  });
}

module.exports = { register };
