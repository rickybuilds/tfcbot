"use strict";

// Challenge records and standings are served by the NoName Bootcamp API.
// Keep only the Bot-side feature gate here; this service must not query the
// Bootcamp database directly.
function challengesEnabled(env = process.env) {
  return String(env.BOOTCAMP_CHALLENGES_ENABLED || "").trim().toLowerCase() === "true";
}

module.exports = { challengesEnabled };
