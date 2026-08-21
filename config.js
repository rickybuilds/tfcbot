// config.js
require("dotenv").config();

module.exports = {
  PREFIX: "!",
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,

  // Channels
  channels: {
    odds: process.env.ODDS_CHANNEL_ID,
    pickup: process.env.PICKUP_CHANNEL_ID,
    clips: process.env.PICKUP_CLIPS_CHANNEL_ID,
    eloAdmin: process.env.ELO_ADMIN_CHANNEL_ID,
    eloTest: process.env.ELOTEST_CHANNEL_ID,
    recap: process.env.RECAP_CHANNEL_ID,
    logs: process.env.LOGS_CHANNEL_ID,
    health: process.env.HEALTH_CHANNEL_ID,
    maps: process.env.MAPS_CHANNEL_ID,
    audit: process.env.AUDIT_CHANNEL_ID,
    request: process.env.TFC_REQUEST_CHANNEL_ID,
    rules: process.env.RULES_CHANNEL_ID,
    settings: process.env.SETTINGS_CHANNEL_ID,
    wants: process.env.WANTS_CHANNEL_ID,
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
  pickupRecordingEnabled: /^(?:1|true|yes|on)$/i.test(
    String(process.env.PICKUP_RECORDING_ENABLED || "")
  ),
  pickupReplayAutoClips: /^(?:1|true|yes|on)$/i.test(
    String(process.env.PICKUP_REPLAY_AUTO_CLIPS || "")
  ),
  pickupReplayAttachWebm: /^(?:1|true|yes|on)$/i.test(
    String(process.env.PICKUP_REPLAY_ATTACH_WEBM || "")
  ),
  // Discord's Level 3 server limit is 100 MB. Some servers may have the
  // newer 250 MB larger-upload experiment, so keep this configurable.
  pickupReplayMaxAttachmentBytes: (() => {
    const megabytes = Number(process.env.PICKUP_REPLAY_MAX_ATTACHMENT_MB || 100);
    return Number.isFinite(megabytes) && megabytes > 0
      ? Math.floor(megabytes * 1_000_000)
      : 100_000_000;
  })(),
  // Elo V2 is intentionally shadow-only for now. "off" disables all polling
  // and recap posts; "shadow" calculates proposals without changing ratings.
  eloV2Mode: String(process.env.ELO_V2_MODE || "off").trim().toLowerCase(),
  mapMaxSelectionsPerUser: (() => {
    const value = Math.max(1, Number(process.env.MAP_MAX_SELECTIONS_PER_USER || 1));
    return Number.isFinite(value) ? value : 1;
  })(),
};
