// Shared winner bonus for ADL and streak-triggered matches.
// Read once at startup; changing .env requires a bot restart.
const rawPercent = String(process.env.ELO_BONUS_PERCENT ?? "").trim();
const parsedPercent = Number(rawPercent);
const WINNER_BONUS_PERCENT = rawPercent !== "" && Number.isFinite(parsedPercent)
  && parsedPercent >= 0 && parsedPercent <= 100 ? parsedPercent : 50;
const WINNER_BONUS_MULTIPLIER = 1 + WINNER_BONUS_PERCENT / 100;

function applyModeMultipliers(match, deltaStandard) {
  // Callers supply a capped normal gain, and only for an actual win.
  // Old multiplier settings and stacking policies no longer apply.
  const hasBonus = match?.mode === "ADL" || Number(match?.rng_multiplier || 1) > 1;
  if (!hasBonus || deltaStandard <= 0) return deltaStandard;
  return Math.round(deltaStandard * WINNER_BONUS_MULTIPLIER);
}

function formatBonusAnnouncement(bonus) {
  const isAdl = bonus.triggeredBy?.includes("ADL Mode");
  const isStreak = !isAdl && bonus.type === "WINNER_ONLY";
  const reason = isAdl ? "ADL Mode" : isStreak ? "streak" : "special rule";
  const players = isStreak && bonus.triggeredBy?.length
    ? `\nPlayers on a streak: ${bonus.triggeredBy.join(", ")}` : "";
  return `🔥 **BONUS ELO ENABLED** (triggered by ${reason})${players}\n` +
    `👀 Winners receive **${WINNER_BONUS_PERCENT}% extra Elo** before performance allocation. Losers take regular Elo losses.`;
}

module.exports = { applyModeMultipliers, formatBonusAnnouncement, WINNER_BONUS_MULTIPLIER, WINNER_BONUS_PERCENT };
