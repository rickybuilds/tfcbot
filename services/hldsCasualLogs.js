// services/hldsCasualLogs.js
"use strict";

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const SFTPClient = require("ssh2-sftp-client");
const fetch = require("node-fetch");
const FormData = require("form-data");

const servers = require("../config/rcon");

const TMP_DIR = path.join(process.cwd(), "tmp", "hlds-casual");
const MIN_KB = 100;
const MAX_SCAN_PER_SERVER = 80;
const LOGS_NEEDED = 2;

const HAMP_BASE = process.env.HAMPALYZER_BASE || "https://app.hampalyzer.com";
const HAMP_UPLOAD_URL =
  process.env.HAMPALYZER_UPLOAD_URL || `${HAMP_BASE}/api/parseGame`;

const TFCSTATS_UPLOAD_URL =
  process.env.TFCSTATS_UPLOAD_URL ||
  "https://www.tfcstats.com/api/parsePickup?skipAwards=true";

const API_KEY = process.env.HAMPALYZER_API_KEY || "";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function safeName(s) {
  return String(s || "unknown").replace(/[^a-z0-9_-]/gi, "-");
}

function cleanup(paths = []) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }
}

function detectMapInLog(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .slice(0, 40);

    for (const line of lines) {
      const m =
        line.match(/Loading map "([^"]+)"/i) ||
        line.match(/Started map "([^"]+)"/i);

      if (m) return m[1];
    }
  } catch (e) {
    console.error("[hldsCasualLogs] detectMapInLog failed:", filePath, e.message);
  }

  return null;
}

function sortLogPaths(paths) {
  return [...paths].sort((a, b) => {
    const getNum = p => {
      const m = path.basename(p).match(/L(\d+)\.log/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    return getNum(a) - getNum(b);
  });
}

// -----------------------------------------------------------------------------
// SFTP / Search
// -----------------------------------------------------------------------------

async function sftpConnect(serverKey, cfg) {
  const sftp = new SFTPClient();
  const ssh = cfg.ssh || {};

  const connectCfg = {
    host: ssh.host,
    port: Number(ssh.port || 22),
    username: ssh.user || ssh.username || process.env.HL_SSH_USER || "steam",
  };

  if (ssh.keyPath && fs.existsSync(ssh.keyPath)) {
    connectCfg.privateKey = fs.readFileSync(ssh.keyPath);
    if (ssh.passphrase) connectCfg.passphrase = ssh.passphrase;
  } else if (ssh.pass) {
    connectCfg.password = ssh.pass;
  } else if (process.env.HL_SSH_KEY_PATH && fs.existsSync(process.env.HL_SSH_KEY_PATH)) {
    connectCfg.privateKey = fs.readFileSync(process.env.HL_SSH_KEY_PATH);
    if (process.env.HL_SSH_KEY_PASSPHRASE) {
      connectCfg.passphrase = process.env.HL_SSH_KEY_PASSPHRASE;
    }
  } else {
    connectCfg.password = process.env.HL_SSH_PASS || process.env.HL_SSH_PASSWORD || "";
  }

  if (!connectCfg.host) {
    throw new Error(`Missing SSH host for ${serverKey}`);
  }

  console.log(`[casual logs] SFTP connecting ${serverKey} -> ${connectCfg.host}:${connectCfg.port}`);
  await sftp.connect(connectCfg);
  return sftp;
}

async function findMatchingLogsOnServer(serverKey, cfg, mapName) {
  const sftp = await sftpConnect(serverKey, cfg);
  const found = [];

  const remoteDir =
    cfg.logDir ||
    process.env[`HL_REMOTE_LOG_DIR_${serverKey.toUpperCase()}`] ||
    process.env.HL_REMOTE_LOG_DIR ||
    "/root/steamcmd/tfc/tfc/logs";

  const workDir = ensureDir(
    path.join(TMP_DIR, safeName(serverKey), safeName(mapName), String(Date.now()))
  );

  try {
    console.log(`[casual logs:${serverKey}] listing ${remoteDir}`);
    const list = await sftp.list(remoteDir);

    const logs = list
      .filter(f => f.type === "-" && /^L\d+\.log$/i.test(f.name))
      .filter(f => Math.round(Number(f.size || 0) / 1024) > MIN_KB)
      .sort((a, b) => Number(b.modifyTime || 0) - Number(a.modifyTime || 0))
      .slice(0, MAX_SCAN_PER_SERVER);

    console.log(`[casual logs:${serverKey}] checking ${logs.length} candidate logs`);

    for (const f of logs) {
      const remotePath = `${remoteDir.replace(/\/+$/, "")}/${f.name}`;
      const localPath = path.join(workDir, f.name);

      try {
        await sftp.fastGet(remotePath, localPath);

        const detectedMap = detectMapInLog(localPath);
        const sizeKb = Math.round(Number(f.size || 0) / 1024);
        const mtimeMs = Number(f.modifyTime || 0) * 1000;

        if (detectedMap?.toLowerCase() === String(mapName).toLowerCase()) {
          found.push({
            serverKey,
            serverName: cfg.name || serverKey,
            localPath,
            map: detectedMap,
            sizeKb,
            mtimeMs,
          });

          console.log(
            `[casual logs:${serverKey}] matched ${f.name} ${detectedMap} ${sizeKb}KB`
          );
        } else {
          cleanup([localPath]);
        }
      } catch (err) {
        cleanup([localPath]);
        console.error(`[casual logs:${serverKey}] failed ${f.name}:`, err.message);
      }
    }
  } finally {
    try { await sftp.end(); } catch {}
  }

  return found;
}

// -----------------------------------------------------------------------------
// Uploads
// -----------------------------------------------------------------------------

async function uploadToHampalyzer({ paths, mapName, casualId }) {
  if (!paths.length) {
    return { ok: false, status: 0, url: null, text: "no files" };
  }

  const form = new FormData();
  form.append("force", "on");
  form.append("matchId", casualId);
  form.append("map", mapName);
  form.append("casual", "true");

  sortLogPaths(paths).forEach((p, i) => {
    const renamed = `casual-${safeName(mapName)}-R${i + 1}-${path.basename(p)}`;
    form.append("logs[]", fs.createReadStream(p), renamed);
  });

  const headers = { ...form.getHeaders() };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(HAMP_UPLOAD_URL, {
    method: "POST",
    headers,
    body: form,
  });

  const raw = await res.text().catch(() => "");
  console.log(
    `[casual logs] Hampalyzer status=${res.status} ok=${res.ok} raw=${raw.slice(0, 500)}`
  );

  let trimmed = raw.trim().replace(/"/g, "");

  if (trimmed.includes("path:")) {
    const m = trimmed.match(/path:([^}]+)}/i);
    if (m?.[1]) trimmed = m[1].trim();
  }

  const url = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed
      ? `${HAMP_BASE}/${trimmed.replace(/^\/+/, "")}`
      : null;

  return { ok: res.ok, status: res.status, url, text: raw };
}

async function uploadToTFCStats({ paths, mapName, casualId }) {
  if (!paths.length) {
    return { ok: false, status: 0, url: null, text: "no files" };
  }

  const form = new FormData();
  form.append("force", "on");
  form.append("matchId", casualId);
  form.append("map", mapName);

  sortLogPaths(paths).forEach(p => {
    const renamed = `casual-${safeName(mapName)}-${path.basename(p)}`;
    form.append("logs[]", fs.createReadStream(p), renamed);
  });

  const res = await fetch(TFCSTATS_UPLOAD_URL, {
    method: "POST",
    headers: form.getHeaders(),
    body: form,
  });

  const raw = await res.text().catch(() => "");
  console.log(
    `[casual logs] TFCStats status=${res.status} ok=${res.ok} raw=${raw.slice(0, 500)}`
  );

  let url = null;

    try {
    const json = JSON.parse(raw);

    url =
        json.url ||
        json.link ||
        json.resultUrl ||
        json.path ||
        json?.success?.url ||
        json?.success?.link ||
        json?.success?.resultUrl ||
        json?.success?.path ||
        null;

    } catch {
    const m = raw.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) url = m[0];
  }

  return { ok: res.ok, status: res.status, url, text: raw };
}

// -----------------------------------------------------------------------------
// Main casual log workflow
// -----------------------------------------------------------------------------

async function uploadCasualLogsForMap(mapName) {
  const map = String(mapName || "").trim();

  if (!map) {
    return { ok: false, error: "Map name required." };
  }

  const casualId = `casual-${safeName(map)}-${Date.now()}`;
  const allMatches = [];

  for (const [serverKey, cfg] of Object.entries(servers || {})) {
    try {
      const matches = await findMatchingLogsOnServer(serverKey, cfg, map);
      allMatches.push(...matches);
    } catch (err) {
      console.error(`[casual logs] ${serverKey} search failed:`, err.message);
    }
  }

  const selected = allMatches
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LOGS_NEEDED);

  if (selected.length < LOGS_NEEDED) {
    cleanup(allMatches.map(x => x.localPath));

    return {
      ok: false,
      error: `Found ${selected.length}/${LOGS_NEEDED} matching logs for "${map}" over ${MIN_KB}KB.`,
    };
  }

  const selectedPaths = selected.map(x => x.localPath);
  const unusedPaths = allMatches
    .filter(x => !selectedPaths.includes(x.localPath))
    .map(x => x.localPath);

  cleanup(unusedPaths);

  try {
    const hampalyzer = await uploadToHampalyzer({
      paths: selectedPaths,
      mapName: map,
      casualId,
    });

    const tfcstats = await uploadToTFCStats({
      paths: selectedPaths,
      mapName: map,
      casualId,
    });

    return {
      ok: true,
      map,
      casualId,
      serverName: selected[0]?.serverName || selected[0]?.serverKey || "unknown",
      hampalyzerUrl: hampalyzer.url,
      tfcstatsUrl: tfcstats.url,
      hampalyzerOk: hampalyzer.ok,
      tfcstatsOk: tfcstats.ok,
    };
  } finally {
    cleanup(selectedPaths);
  }
}

// -----------------------------------------------------------------------------
// Discord command runner
// -----------------------------------------------------------------------------

async function runCasualLogs({ mapName, message, config }) {
  const map = String(mapName || "").trim();

  if (!map) {
    return message.reply("Usage: `!logs <mapname>`");
  }

  const progressMsg = await message.reply(
    `🔎 Searching recent logs for **${map}** on all servers...`
  );

  try {
    const result = await uploadCasualLogsForMap(map);

    if (!result.ok) {
      return progressMsg.edit(`❌ ${result.error || "No matching logs found."}`);
    }

    const emb = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("NoName Pickups Casual Game")
      .addFields(
        { name: "Map", value: result.map || map, inline: true },
        { name: "Server", value: result.serverName || "unknown", inline: true },
        {
          name: "Hampalyzer",
          value: result.hampalyzerUrl
            ? `[Open Hampalyzer](${result.hampalyzerUrl})`
            : "Upload failed",
          inline: false,
        },
        {
          name: "TFCStats",
          value: result.tfcstatsUrl
            ? `[Open TFCStats](${result.tfcstatsUrl})`
            : "Upload failed",
          inline: false,
        }
      )
      .setFooter({ text: `Requested by ${message.author.tag}` })
      .setTimestamp();

    const logsChannelId = process.env.LOGS_CHANNEL_ID || config.channels.logs;
    const logsChannel = logsChannelId
      ? await message.client.channels.fetch(logsChannelId).catch(() => null)
      : null;

    if (logsChannel?.send) {
      await logsChannel.send({ embeds: [emb] });

      try { await progressMsg.delete(); } catch {}
      try { await message.delete(); } catch {}

      return;
    }

    return progressMsg.edit({ content: "", embeds: [emb] });
  } catch (err) {
    console.error("[!logs casual error]", err);
    return progressMsg.edit("Error while uploading casual logs.");
  }
}

module.exports = {
  runCasualLogs,
  uploadCasualLogsForMap,
};