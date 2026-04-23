// commands/onboarding.js
"use strict";

const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const { guardChannel } = require("../lib/guards");

function parseUserId(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^<@!?(\d{15,22})>$/);
  if (m) return m[1];
  if (/^\d{15,22}$/.test(str)) return str;
  return null;
}

async function addRoleToMember({ guild, member, roleId, channel, reason = "Granted via bot command" }) {
  const role =
    guild.roles.cache.get(roleId) ||
    (await guild.roles.fetch(roleId).catch(() => null));

  if (!role) {
    await channel.send("⚠️ I can’t find that role. Check the role ID in .env/config.");
    return false;
  }

  if (member.roles.cache.has(role.id)) {
    await channel.send(`✅ <@${member.id}> already has **${role.name}**.`);
    return true;
  }

  const me = guild.members.me || (await guild.members.fetch(channel.client.user.id));
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await channel.send("❌ I’m missing **Manage Roles** permission.");
    return false;
  }
  if (role.position >= me.roles.highest.position) {
    await channel.send("❌ I can’t assign that role (it’s higher than my highest role).");
    return false;
  }

  try {
    await member.roles.add(role, reason);
    const emb = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(`🎉 <@${member.id}> has been granted **${role.name}**.`)
      .setTimestamp();
    await channel.send({ embeds: [emb] });
    return true;
  } catch (e) {
    console.error("[onboarding] add role failed:", e);
    await channel.send("❌ I couldn’t assign the role (permissions or hierarchy issue).");
    return false;
  }
}

function register(reg, { config }) {
  const REQUEST_CH_ID = String(config.channels.request || "");
  const PRIVACY_ROLE_ID = String(config.roles.player || "");
  const MAPPER_ROLE_ID = String(config.roles.mapper || "");
  const ADMIN_ROLE_ID = String(config.roles.admin || "");

  // 🔹 !tfc command
  reg.set("tfc", async (message, args = []) => {
    if (!(await guardChannel(message, REQUEST_CH_ID))) return;

    const guild = message.guild;
    if (!guild) return;

    // Admin can grant to others
    if (args.length > 0) {
      const invoker =
        message.member || (await guild.members.fetch(message.author.id).catch(() => null));
      if (!invoker) return;

      if (!invoker.roles.cache.has(ADMIN_ROLE_ID)) {
        return message.channel.send("⛔ You don’t have permission to grant this role to others.");
      }

      const targetId = parseUserId(args[0]);
      if (!targetId) {
        return message.channel.send("Usage: `!tfc @user` (mention the user to grant the role).");
      }

      const target =
        guild.members.cache.get(targetId) ||
        (await guild.members.fetch(targetId).catch(() => null));
      if (!target) {
        return message.channel.send("I can’t find that user in this server.");
      }

      return addRoleToMember({
        guild,
        member: target,
        roleId: PRIVACY_ROLE_ID,
        channel: message.channel,
        reason: "Granted via !tfc",
      });
    }

    // Regular self-grant
    const member =
      message.member || (await guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    return addRoleToMember({
      guild,
      member,
      roleId: PRIVACY_ROLE_ID,
      channel: message.channel,
      reason: "Granted via !tfc",
    });
  });

  // 🔹 !mapper command
  reg.set("mapper", async (message, args = []) => {
    if (!(await guardChannel(message, REQUEST_CH_ID))) return;

    const guild = message.guild;
    if (!guild) return;

    // Admin can grant to others
    if (args.length > 0) {
      const invoker =
        message.member || (await guild.members.fetch(message.author.id).catch(() => null));
      if (!invoker) return;

      if (!invoker.roles.cache.has(ADMIN_ROLE_ID)) {
        return message.channel.send("⛔ You don’t have permission to grant this role to others.");
      }

      const targetId = parseUserId(args[0]);
      if (!targetId) {
        return message.channel.send("Usage: `!mapper @user` (mention the user to grant the role).");
      }

      const target =
        guild.members.cache.get(targetId) ||
        (await guild.members.fetch(targetId).catch(() => null));
      if (!target) {
        return message.channel.send("I can’t find that user in this server.");
      }

      return addRoleToMember({
        guild,
        member: target,
        roleId: MAPPER_ROLE_ID,
        channel: message.channel,
        reason: "Granted via !mapper",
      });
    }

    // Regular self-grant
    const member =
      message.member || (await guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    return addRoleToMember({
      guild,
      member,
      roleId: MAPPER_ROLE_ID,
      channel: message.channel,
      reason: "Granted via !mapper",
    });
  });
}

module.exports = { register };
