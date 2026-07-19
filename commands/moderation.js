// commands/moderation.js
"use strict";

const { PermissionsBitField } = require("discord.js");
const { postQueueBoard } = require("./queue");
const { refreshBotName } = require("../lib/botName");
const { sendAuditLog } = require("../lib/auditLog");

	function isAdmin(message, config) {
	  const m = message.member;
	  if (!m) return false;
	  if (m.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
	  const roleId = String(config.roles.admin || "");
	  return roleId && m.roles?.cache?.has(roleId);
	}

	async function removeFromQueueAndRefresh(userId, message, { state, elo, privacy }) {
	  const before = state.queue.length;
	  state.queue = state.queue.filter(p => String(p.id) !== String(userId));
	  if (state.queue.length !== before) {
		try { await postQueueBoard(message.channel, state, elo, privacy); } catch {}
		try { await refreshBotName(message.client, state); } catch {}
	  }
	  try { message.client?.persistQueueSoon?.(); } catch {}
	}

	async function giveRole(member, roleId) { if (roleId) await member.roles.add(roleId).catch(() => {}); }
	async function removeRole(member, roleId) { if (roleId) await member.roles.remove(roleId).catch(() => {}); }

	const audit = (message, text, config) => sendAuditLog({
	  client: message.client,
	  channelId: config.channels.audit,
	  payload: text,
	});

	function register(registry, deps) {
	  const { state, elo, privacy, config, banStore } = deps;
	  const ROLE_PERMABAN = config.roles.permaban;
	  const ROLE_RETURN_AFTER = config.roles.returnAfter;

	  state.bannedUsers = state.bannedUsers || new Set();

	/* ---------------- !kick ---------------- */
	registry.set("kick", async (message) => {
	  if (!isAdmin(message, config)) return;
	  const target = message.mentions?.users?.first();
	  if (!target) return message.channel.send("Usage: `!kick @user`");

	  await removeFromQueueAndRefresh(target.id, message, { state, elo, privacy });

	  // ✅ FIXED: pass config as 3rd argument
	  await audit(
		message,
		`👞 KICK: <@${message.author.id}> kicked <@${target.id}> from queue.`,
		config
	  );

	  try {
		await message.channel.send(`Kicked <@${target.id}> from the queue.`);
	  } catch {}
	});

	/* ---------------- !permaban ---------------- */
	registry.set("permaban", async (message) => {
	  if (!isAdmin(message, config)) return;
	  const target = message.mentions?.users?.first();
	  if (!target) return message.channel.send("Usage: `!permaban @user`");

	  const member = await message.guild.members.fetch(target.id).catch(() => null);
	  if (!member) return message.channel.send("I can't find that member in this server.");

	  await giveRole(member, ROLE_PERMABAN);
	  state.bannedUsers.add(String(target.id));
	  await removeFromQueueAndRefresh(target.id, message, { state, elo, privacy });

	  try {
		await target.send(
		  "⛔ You have been **permanently banned**. The bot will ignore your interactions.\n" +
		  `Contact ${message.author} for further details.`
		);
	  } catch {
		console.log(`[permaban notice failed] Could not DM ${target.id}`);
	  }

	  // ✅ FIXED
	  await audit(message, `⛔ PERMABAN: <@${message.author.id}> permabanned <@${target.id}>.`, config);

	  try { await message.delete().catch(() => {}); } catch {}
	});


	/* ---------------- !ban (game-based) ---------------- */
	registry.set("ban", async (message, args = []) => {
	  if (!isAdmin(message, config)) return;
	  const target = message.mentions?.users?.first();
	  const games = parseInt(args[1], 10);

	  if (!target || isNaN(games) || games <= 0) {
		return message.channel.send("Usage: `!ban @user <games>` — e.g., `!ban @user 2`");
	  }

	  const reason = args.slice(2).join(" ") || "unspecified";
	  banStore.upsertBan(target.id, games, reason);

	  state.bannedUsers.add(String(target.id));
	  await removeFromQueueAndRefresh(target.id, message, { state, elo, privacy });

	  try {
		await target.send(
		  `You have been banned for **${games} game(s)**.\n` +
		  `Reason: ${reason}.\n` +
		  `Contact ${message.author} for more details.`
		);
	  } catch {
		console.log(`[ban notice failed] Could not DM ${target.id}`);
	  }

	  // ✅ FIXED
	  await audit(
		message,
		`🚫 BAN: <@${message.author.id}> banned <@${target.id}> for ${games} games. Reason: ${reason}`,
		config
	  );

	  try { await message.delete().catch(() => {}); } catch {}
	});


	/* ---------------- !unban ---------------- */
	registry.set("unban", async (message) => {
	  if (!isAdmin(message, config)) return;
	  const target = message.mentions?.users?.first();
	  if (!target) return message.channel.send("Usage: `!unban @user`");

	  banStore.deleteBan(target.id);
	  state.bannedUsers.delete(String(target.id));

	  const member = await message.guild.members.fetch(target.id).catch(() => null);
	  if (member) {
		await removeRole(member, ROLE_PERMABAN);
		await giveRole(member, ROLE_RETURN_AFTER);
	  }

	  try {
		await target.send("✅ You have been unbanned by an admin. Contact staff if you have any questions.");
	  } catch {
		console.log(`[unban notice failed] Could not DM ${target.id}`);
	  }

	  // ✅ FIXED
	  await audit(message, `✅ UNBAN: <@${message.author.id}> unbanned <@${target.id}>.`, config);

	  try { await message.delete().catch(() => {}); } catch {}
	});

  /* ---------------- !listbans ---------------- */
  registry.set("listbans", async (message) => {
    if (!isAdmin(message, config)) return;
    const bans = banStore.getAllBans();
    if (!bans.length) return message.channel.send("No active bans.");

    const lines = bans.map(
      b => `<@${b.userId}> — ${b.gamesRemaining} games remaining (reason: ${b.reason})`
    );
    await message.channel.send("**Active Bans:**\n" + lines.join("\n"));
  });
}

/* ---------------- vote text-only moderation ---------------- */

const MEDIA_URL_REGEX =
  /(tenor\.com|giphy\.com|klipy\.com|media\.discordapp\.net|cdn\.discordapp\.com|\bgifs?\b|\.jpg|\.jpeg|\.png|\.webp|\.mp4|\.mov)/i;

function hasBlockedVoteMedia(message) {
  if (message.attachments?.size > 0) return true;
  if (message.stickers?.size > 0) return true;
  if (message.embeds?.length > 0) return true;
  if (MEDIA_URL_REGEX.test(message.content || "")) return true;

  return false;
}

async function handleVoteMediaModeration(message, state, config) {
  if (!message.guild) return false;
  if (message.author.bot) return false;

  // Only moderate the pickup channel
  if (message.channel.id !== config.channels.pickup) return false;

  // Only during voting
  if (!state.isVotingInProgress) return false;

  if (!hasBlockedVoteMedia(message)) return false;

  await message.delete().catch(() => {});
  return true;
}

module.exports = {
  register,
  hasBlockedVoteMedia,
  handleVoteMediaModeration,
};
