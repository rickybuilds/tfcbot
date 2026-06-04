"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config();
const sqlite3 = require("sqlite3").verbose();
const SFTPClient = require("ssh2-sftp-client");

// --- env-based config (same as hldsTransfer.js)
const REMOTE_DIR = process.env.HL_REMOTE_LOG_DIR || "/root/steamcmd/tfc/tfc/logs";
const TMP_DIR = path.join(process.cwd(), "tmp", "hlds-logs", "parse");
const HL_HOST = process.env.HL_SSH_HOST || "127.0.0.1";
const HL_PORT = Number(process.env.HL_SSH_PORT || 22);
const HL_USER = process.env.HL_SSH_USER || "steam";
const HL_PASS = process.env.HL_SSH_PASSWORD || process.env.HL_SSH_PASS;
const HL_KEY = process.env.HL_SSH_KEY_PATH;
const HL_KEY_PASSPHRASE = process.env.HL_SSH_KEY_PASSPHRASE;

const db = new sqlite3.Database(path.join(__dirname, "../elo.db"));
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

// --- connect to remote server
async function sftpConnect() {
  const sftp = new SFTPClient();
  const cfg = { host: HL_HOST, port: HL_PORT, username: HL_USER };

  if (HL_KEY && fs.existsSync(HL_KEY)) {
    cfg.privateKey = fs.readFileSync(HL_KEY);
    if (HL_KEY_PASSPHRASE) cfg.passphrase = HL_KEY_PASSPHRASE;
  } else if (HL_PASS) {
    cfg.password = HL_PASS;
  } else {
    throw new Error("Missing SFTP credentials");
  }

  console.log(`[SFTP] Connecting to ${cfg.host}:${cfg.port} as ${cfg.username}`);
  await sftp.connect(cfg);
  return sftp;
}

// --- SteamID to SteamID64
function steamTo64(steamId) {
  const m = steamId.match(/^STEAM_[0-5]:(\d):(\d+)$/);
  if (!m) return null;
  const [_, y, z] = m;
  return String(BigInt(z) * 2n + BigInt(y) + 76561197960265728n);
}

// --- parse one log for name+steamid pairs
function parseLogFile(filePath, found) {
  const content = fs.readFileSync(filePath, "utf8");
  const regex = /"([^"]+)<\d+><(STEAM_[0-5]:[01]:\d+)></g;
  let m;
  while ((m = regex.exec(content))) {
    const name = m[1].trim();
    const steam = m[2];
    if (!found.has(steam)) found.set(steam, name);
  }
}

// --- main routine
async function main() {
  ensureDir(TMP_DIR);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_names (
      steam_id TEXT PRIMARY KEY,
      name TEXT
    );
  `);

  const sftp = await sftpConnect();
  const base = REMOTE_DIR.replace(/\/+$/, "");
  const list = await sftp.list(base);
  const logFiles = list.filter(f => f.name.endsWith(".log")).sort((a,b)=>b.modifyTime-a.modifyTime);

  console.log(`[SFTP] Found ${logFiles.length} log files on remote host`);

  const found = new Map();
  let processed = 0;

  for (const file of logFiles) {
    const remotePath = `${base}/${file.name}`;
    const localPath = path.join(TMP_DIR, file.name);

    try {
      await sftp.fastGet(remotePath, localPath);
      parseLogFile(localPath, found);
      fs.unlinkSync(localPath);
      processed++;
      if (processed % 50 === 0) console.log(`   ...${processed} logs parsed`);
    } catch (err) {
      console.error(`[Error parsing ${file.name}]:`, err.message);
    }
  }

  await sftp.end();

  console.log(`👥 Found ${found.size} unique SteamIDs`);

  let inserted = 0;
  for (const [steam, name] of found.entries()) {
    const steam64 = steamTo64(steam);
    if (!steam64) continue;

    await new Promise((res) => {
      db.run(
        "INSERT OR IGNORE INTO player_links (discord_id, steam_id, verified) VALUES (NULL, ?, 0)",
        [steam64],
        (err) => { if (err) console.error("[DB player_links]", err.message); res(); }
      );
    });

    await new Promise((res) => {
      db.run(
        "INSERT OR REPLACE INTO player_names (steam_id, name) VALUES (?, ?)",
        [steam64, name],
        (err) => { if (err) console.error("[DB player_names]", err.message); else inserted++; res(); }
      );
    });
  }

  console.log(`✅ Inserted/updated ${inserted} player names from ${processed} logs.`);
  db.close();
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  db.close();
});
