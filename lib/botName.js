// lib/botName.js
"use strict";

/**
 * Computes the display name based on queue and voting state.
 */
function formatBotName({ count = 0, max = 8, isVoting = false }) {
  if (isVoting) return "PugBot (Voting in Progress)";
  if (!count)   return "PugBot";
  return `PugBot (${count}/${max})`;
}

/**
 * Set the bot's nickname across all guilds where it's present.
 * Requires the bot to have "Manage Nicknames" permission.
 */
async function setNicknameAllGuilds(client, name) {
  const guilds = client.guilds.cache;
  for (const [, guild] of guilds) {
    try {
      const me = guild.members.me || await guild.members.fetchMe();
      // Skip if already the same (saves API calls)
      if (me.nickname === name || (!me.nickname && me.user.username === name)) continue;
      await me.setNickname(name).catch(() => {});
    } catch (_) {}
  }
}

/**
 * Refresh name using state.
 * Tries to read queue length and max players from your existing state/config.
 */
async function refreshBotName(client, state) {
  // Pull queue count
  let count = 0;
  try {
    // Adapt to your queue structure
    if (Array.isArray(state.queue)) count = state.queue.length;
    else if (Array.isArray(state.participants)) count = state.participants.length;
    else if (state.queue?.participants) count = state.queue.participants.length;
  } catch {}

  // Pull max players
  const max =
	  Number(state?.MAX_PLAYERS) ||
	  Number(state?.config?.MAX_PLAYERS) ||
	  Number(process.env.MAX_PLAYERS) || 8;

  const isVoting = !!state.isVotingInProgress;

  const name = formatBotName({ count, max, isVoting });
  await setNicknameAllGuilds(client, name);
}

module.exports = {
  formatBotName,
  setNicknameAllGuilds,
  refreshBotName,
};
