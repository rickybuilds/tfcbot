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
    name: "TFC CENTRAL Server",
    host: process.env.TFC_RCON_CENTRAL_HOST,
    port: parseInt(process.env.TFC_RCON_CENTRAL_PORT || "27015", 10),
    password: process.env.TFC_RCON_CENTRAL_PASS,
    url: "https://tinyurl.com/centralnoname",
    ssh: {
      host: process.env.HL_SSH_HOST_CENTRAL || process.env.HL_SSH_HOST,
      port: parseInt(process.env.HL_SSH_PORT || "22", 10),
      user: process.env.HL_SSH_USER,
      pass: process.env.HL_SSH_PASS,
    },
    logDir: process.env.HL_REMOTE_LOG_DIR_CENTRAL || process.env.HL_REMOTE_LOG_DIR,
    hltvDir: process.env.HL_REMOTE_HLTV_DIR_CENTRAL || process.env.HL_REMOTE_HLTV_DIR,
  };
}

module.exports = servers;
