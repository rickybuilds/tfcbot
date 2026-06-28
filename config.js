// config.js
require("dotenv").config();

module.exports = {
  PREFIX: "!",
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,

  // Channels
  channels: {
    odds: process.env.ODDS_CHANNEL_ID,
    oddsDebug: process.env.ODDS_DEBUG === "true",
    pickup: process.env.PICKUP_CHANNEL_ID,
    eloAdmin: process.env.ELO_ADMIN_CHANNEL_ID,
    recap: process.env.RECAP_CHANNEL_ID,
    logs: process.env.LOGS_CHANNEL_ID,
    health: process.env.HEALTH_CHANNEL_ID,
    maps: process.env.MAPS_CHANNEL_ID,
    audit: process.env.AUDIT_CHANNEL_ID,
    request: process.env.TFC_REQUEST_CHANNEL_ID,
    rules: process.env.RULES_CHANNEL_ID,
    settings: process.env.SETTINGS_CHANNEL_ID,
    wants: process.env.WANTS_CHANNEL_ID, // 👈 NEW
  },

  // Roles
  roles: {
    admin: process.env.ADMIN_ROLE_ID,
    privacy: process.env.PRIVACY_ROLE_ID, //currently not used
    player: process.env.PRIVACY_ROLE_ID,
    captain: process.env.CAPTAIN_ROLE_ID, //currently not used
    mapper: process.env.MAPPER_ROLE_ID,
    notice: process.env.PRIVACY_ROLE_ID,
    permaban: process.env.PERMABAN_ROLE_ID,
    tempban: process.env.TEMPBAN_ROLE_ID,
    jail: process.env.JAIL_ROLE_ID,
  },

  // UI / Game
  MAX_BUTTONS: 9,
  MAX_PLAYERS: Number(process.env.MAX_PLAYERS) || 8,
  mapMaxSelectionsPerUser: (() => {
    const value = Math.max(1, Number(process.env.MAP_MAX_SELECTIONS_PER_USER || 1));
    return Number.isFinite(value) ? value : 1;
  })(),
};