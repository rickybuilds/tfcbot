"use strict";

const OWNER_ID = "255834576742645761";
const COUNTDOWN_DELAY_MS = 650;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execute(message, _args, options = {}) {
  if (String(message.author?.id || "") !== OWNER_ID) {
    return message.reply("🚫 Nice try — `!selfdestruct` is owner-only.");
  }

  const delayMs = Number.isFinite(options.delayMs)
    ? Math.max(0, options.delayMs)
    : COUNTDOWN_DELAY_MS;

  const progress = await message.reply("⚠️ **CRITICAL COMMAND ACCEPTED**");
  const updates = [
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████░░░░░░░░░░░░░░░░] 20%`",
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████████░░░░░░░░░░░░] 40%`\n🛰 Simulating Discord relay shutdown...",
    "⚠️ **CRITICAL COMMAND ACCEPTED**\nInitializing emergency shutdown protocol...\n`[████████████░░░░░░░░] 60%`\n🛰 Simulating Discord relay shutdown...\n🗄 Pretending to delete absolutely nothing...",
    "⚠️ **FINAL WARNING**\nCancellation window closes in 3 seconds.\n\n💥 3... 2... 1...",
    "😎 **SELF-DESTRUCT CANCELED**\n\nYou got pranked. Nothing was changed. Probably.",
  ];

  for (const update of updates) {
    await wait(delayMs);
    if (typeof progress?.edit === "function") {
      await progress.edit(update);
    } else {
      await message.reply(update);
    }
  }

  return progress;
}

function register(registry) {
  registry.set("selfdestruct", (message, args) => execute(message, args));
}

module.exports = { COUNTDOWN_DELAY_MS, OWNER_ID, execute, register };
