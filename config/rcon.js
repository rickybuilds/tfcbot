// config/rcon.js
require("dotenv").config();

const servers = {
  east: {
    name: "TFC East US Server",
    host: process.env.TFC_RCON_EAST_HOST,
    port: parseInt(process.env.TFC_RCON_EAST_PORT || "27015", 10),
    password: process.env.TFC_RCON_EAST_PASS,
    url: "https://tinyurl.com/eastnoname",
    ssh: {
      host: process.env.HL_SSH_HOST,
      port: parseInt(process.env.HL_SSH_PORT || "22", 10),
      user: process.env.HL_SSH_USER,
      pass: process.env.HL_SSH_PASS,
    },
    logDir: process.env.HL_REMOTE_LOG_DIR || "logs",
    hltvDir: process.env.HL_REMOTE_HLTV_DIR || "HLTVEAST",
  },
};

if (process.env.TFC_RCON_CENTRAL_HOST) {
  servers.central = {
    name: "TFC Central US Server",
    host: process.env.TFC_RCON_CENTRAL_HOST,
    port: parseInt(process.env.TFC_RCON_CENTRAL_PORT || "27015", 10),
    password: process.env.TFC_RCON_CENTRAL_PASS,
    url: "https://tinyurl.com/nncentralpickup",
    ssh: {
      host: process.env.HL_SSH_HOST_CENTRAL || process.env.HL_SSH_HOST,
      port: parseInt(process.env.HL_SSH_PORT || "22", 10),
      user: process.env.HL_SSH_USER,
      pass: process.env.HL_SSH_PASS,
    },
    logDir: process.env.HL_REMOTE_LOG_DIR_CENTRAL || process.env.HL_REMOTE_LOG_DIR,
    hltvDir: process.env.HL_REMOTE_HLTV_DIR_CENTRAL || process.env.HL_REMOTE_HLTV_DIR,
  };

if (process.env.TFC_RCON_WEST_HOST) {
  servers.west = {
    name: "TFC West US Server",
    host: process.env.TFC_RCON_WEST_HOST,
    port: parseInt(process.env.TFC_RCON_WEST_PORT || "27015", 10),
    password: process.env.TFC_RCON_WEST_PASS,
    url: "https://tinyurl.com/nnpickupwest",
    ssh: {
      host: process.env.HL_SSH_HOST_WEST || process.env.HL_SSH_HOST,
      port: parseInt(process.env.HL_SSH_PORT || "22", 10),
      user: process.env.HL_SSH_USER,
      pass: process.env.HL_SSH_PASS,
    },
    logDir: process.env.HL_REMOTE_LOG_DIR_WEST || process.env.HL_REMOTE_LOG_DIR,
    hltvDir: process.env.HL_REMOTE_HLTV_DIR_WEST || process.env.HL_REMOTE_HLTV_DIR,
  };
}
}

// Skill servers share the same host as their competitive counterpart but run
// on port 27016. Keep them out of servers.json: that file is the source for
// pickup server voting. These internal entries exist only so HLDS log events
// can be attributed to the correct server for player tracking.
function addSkillTrackingServer(region, envPrefix) {
  const base = servers[region];
  const host = process.env[`${envPrefix}_SKILL_HOST`] || base?.host;
  if (!host || !base) return;

  const port = parseInt(process.env[`${envPrefix}_SKILL_PORT`] || "27016", 10);

  servers[`${region}Skill`] = {
    name: `${base.name} Skill Server`,
    host,
    port,
    logSourcePort: port,
    password:
      process.env[`${envPrefix}_SKILL_PASS`] || base.password,
    trackingOnly: true,
  };
}

addSkillTrackingServer("east", "TFC_RCON_EAST");
addSkillTrackingServer("central", "TFC_RCON_CENTRAL");
addSkillTrackingServer("west", "TFC_RCON_WEST");

module.exports = servers;
