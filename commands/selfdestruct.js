"use strict";

const OWNER_ID = "255834576742645761";
const COUNTDOWN_DELAY_MS = 750;

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

  await message.reply("⚠️ SELF-DESTRUCT SEQUENCE INITIATED...");
  await wait(delayMs);
  await message.reply("💥 3... 2... 1...");
  await wait(delayMs);
  return message.reply("😎 Self-destruct canceled. You got pranked.");
}

function register(registry) {
  registry.set("selfdestruct", (message, args) => execute(message, args));
}

module.exports = { COUNTDOWN_DELAY_MS, OWNER_ID, execute, register };
