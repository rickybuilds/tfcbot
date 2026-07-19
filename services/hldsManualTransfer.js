// services/hldsManualTransfer.js
"use strict";

const fs = require("fs");
const path = require("path");
const ensureDir = require("../lib/ensureDir");
const SFTPClient = require("ssh2-sftp-client");

const REMOTE_DIR = process.env.HL_REMOTE_LOG_DIR || "/root/steamcmd/tfc/tfc/logs";
const TMP_DIR    = path.join(process.cwd(), "tmp", "hlds-manual");

async function sftpConnect() {
  const sftp = new SFTPClient();
  const cfg = {
    host: process.env.HL_SSH_HOST || "127.0.0.1",
    port: Number(process.env.HL_SSH_PORT || 22),
    username: process.env.HL_SSH_USER || "steam",
  };

  if (process.env.HL_SSH_KEY_PATH && fs.existsSync(process.env.HL_SSH_KEY_PATH)) {
    cfg.privateKey = fs.readFileSync(process.env.HL_SSH_KEY_PATH);
    if (process.env.HL_SSH_KEY_PASSPHRASE) cfg.passphrase = process.env.HL_SSH_KEY_PASSPHRASE;
  } else if (process.env.HL_SSH_PASSWORD || process.env.HL_SSH_PASS) {
    cfg.password = process.env.HL_SSH_PASSWORD || process.env.HL_SSH_PASS;
  } else {
    throw new Error("SFTP auth missing");
  }

  await sftp.connect(cfg);
  return sftp;
}

function detectMapInLog(filePath) {
  try {
    const firstLines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .slice(0, 20);
    for (const line of firstLines) {
      const m = line.match(/Loading map "([^"]+)"/i);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function findLogsForMatch(matchId, expectedMap, limit = 20) {
  const sftp = await sftpConnect();
  const results = [];

  try {
    const list = await sftp.list(REMOTE_DIR);

    // newest → oldest
    const logs = list
      .filter(f => f.type === "-" && /^L\d+\.log$/i.test(f.name))
      .sort((a, b) => b.modifyTime - a.modifyTime) // sort DESC
      .slice(0, limit); // take N newest

    const workDir = ensureDir(path.join(TMP_DIR, String(matchId)));

    for (const f of logs) {
      try {
        const remotePath = path.join(REMOTE_DIR, f.name);
        const localPath  = path.join(workDir, f.name);

        // download log locally
        await sftp.fastGet(remotePath, localPath);

        // detect map
        const map = detectMapInLog(localPath) || "unknown";
        console.log(`[!logs] ${f.name} → ${map}`);

        results.push({
          file: f.name,
          map,
          mtime: f.modifyTime * 1000,
          sizeKb: Math.round(f.size / 1024),
        });
      } catch (err) {
        console.error("[!logs] failed to read", f.name, err);
      }
    }
  } finally {
    try { await sftp.end(); } catch {}
  }

  return expectedMap
    ? results.filter(r => r.map.toLowerCase() === expectedMap.toLowerCase())
    : results;
}


module.exports = { findLogsForMatch };
