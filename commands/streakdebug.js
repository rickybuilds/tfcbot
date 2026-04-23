"use strict";

function register(reg, { streaks, elo }) {
  // Show a user’s streak
  reg.set("streakshow", async (message) => {
    const u = message.mentions?.users?.first();
    if (!u) return message.channel.send("Usage: `!streakshow @user`");
    const n = streaks.get(u.id) || 0;
    return message.channel.send(`🎯 <@${u.id}> streak: **${n}**`);
  });

  // Force-set a streak for quick testing
  reg.set("streakset", async (message, args=[]) => {
    const u = message.mentions?.users?.first();
    const n = parseInt(args[1], 10);
    if (!u || !Number.isFinite(n)) return message.channel.send("Usage: `!streakset @user <wins>`");
    streaks.set?.(u.id, Math.max(0, n)); // add set() in your winstreak store
    return message.channel.send(`✅ Set streak for <@${u.id}> to **${n}**`);
  });

  // Clear streak
  reg.set("streakclear", async (message) => {
    const u = message.mentions?.users?.first();
    if (!u) return message.channel.send("Usage: `!streakclear @user`");
    streaks.reset(u.id);
    return message.channel.send(`🧹 Cleared streak for <@${u.id}>`);
  });
}

module.exports = { register };
