// lib/modeElo.js
// Central place to apply mode-based Elo multipliers (ADL, RNG hot-streak).
function highestMultiplier(match, cfg) {
  const adlMult = match?.mode === "ADL" ? Number(process.env.ADL_ELO_MULTIPLIER || cfg?.ADL_ELO_MULTIPLIER || 3.0) : 1.0;
  const rngMult = Number(match?.rng_multiplier || 1.0);
  const policy = (process.env.HOTSTREAK_STACKING_POLICY || "highest").toLowerCase(); // "highest" or "multiply"
  if (policy === "multiply") return adlMult * Math.max(1, rngMult);
  return Math.max(adlMult, Math.max(1, rngMult));
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function applyModeMultipliers(match, deltaStandard, cfg = {}) {
  console.log("[modeElo] called with", { mode: match?.mode, rng: match?.rng_multiplier, deltaStandard });
  const winnersOnlyRng = String(process.env.HOTSTREAK_WINNERS_ONLY || cfg.HOTSTREAK_WINNERS_ONLY || "true") === "true";
  const maxDeltaAdl = Number(process.env.ADL_ELO_MAX_DELTA || cfg.ADL_ELO_MAX_DELTA || 45);
  const maxDeltaRng = Number(process.env.HOTSTREAK_MAX_DELTA || cfg.HOTSTREAK_MAX_DELTA || 60);

  let mult = highestMultiplier(match, cfg);
  let delta = deltaStandard * mult;

  // If RNG winners-only and match has rng, you should apply multiplier only when your player is on winning team.
  // This file doesn’t know per-player team result, so call-site can choose to pass deltaStandard already signed appropriately.
  const cap = match?.mode === "ADL" && mult > 1 && (match?.rng_multiplier || 1) <= 1
    ? maxDeltaAdl
    : (match?.rng_multiplier > 1 ? maxDeltaRng : maxDeltaAdl);

  return clamp(delta, -cap, +cap);
}

module.exports = { applyModeMultipliers };
