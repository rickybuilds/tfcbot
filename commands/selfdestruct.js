"use strict";

const OWNER_ID = "255834576742645761";
const COUNTDOWN_DELAY_MS = 2000;
const FINAL_DELAY_MS = 2000;

const LOADING_STEPS = [
  "Loading nonamepugs...",
  "Loading elo.db...",
  "Loading nonamepugs-website...",
  "Loading pickup queue...",
  "Loading match history...",
  "Loading map pools...",
  "Loading server configs...",
  "Loading voice relay...",
  "Loading player rankings...",
  "Loading backups...",
  "Loading moderation rules...",
  "Loading Steam links...",
  "Loading pickup replay archives...",
  "Loading the last remaining brain cell...",
  "Loading goodbye message...",
];

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
  const finalDelayMs = Number.isFinite(options.finalDelayMs)
    ? Math.max(0, options.finalDelayMs)
    : FINAL_DELAY_MS;

  const progress = await message.reply("⚠️ **NONAMEPUGS SHUTDOWN PROTOCOL**");
  const loaded = [];

  for (let i = 0; i < LOADING_STEPS.length; i += 1) {
    await wait(delayMs);
    loaded.push(LOADING_STEPS[i]);
    const percent = Math.round(((i + 1) / LOADING_STEPS.length) * 100);
    const filled = Math.round(percent / 5);
    const bar = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
    const update = `${loaded.join("\n")}\n\nProgress: [${bar}] ${percent}%`;
    if (typeof progress?.edit === "function") {
      await progress.edit(update);
    } else {
      await message.reply(update);
    }
  }

  await wait(finalDelayMs);
  const goodbye = "⚠️ **THIS IS GOODBYE.**\n\nThe server will be missed.";
  if (typeof progress?.edit === "function") await progress.edit(goodbye);
  else await message.reply(goodbye);

  await wait(finalDelayMs);
  const reveal = "😎 **Never mind.**\n\nYou got pranked. Nothing was changed.";
  if (typeof progress?.edit === "function") await progress.edit(reveal);
  else await message.reply(reveal);

  return progress;
}

function register(registry) {
  registry.set("selfdestruct", (message, args) => execute(message, args));
}

module.exports = { COUNTDOWN_DELAY_MS, FINAL_DELAY_MS, LOADING_STEPS, OWNER_ID, execute, register };
