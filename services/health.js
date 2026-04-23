// services/health.js
"use strict";

const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const Client = require("ssh2-sftp-client");

// ---------- Timeouts (env overrides) ----------
const SFTP_CONNECT_MS = Number(process.env.SFTP_CONNECT_MS || 5000);
const SFTP_LIST_MS    = Number(process.env.SFTP_LIST_MS || 3000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 4000);

// ---------- Helper: Promise timeout ----------
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) =>
    (timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms (${label})`)), ms))
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- Helper: HTTP ping ----------
async function fetchWithTimeout(url, opts = {}, ms = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Gather health info from the bot, HLDS, SFTP, Hampalyzer, etc.
 */
async function gatherHealth(client, env = process.env) {
  const out = {};

  // 🧩 Basic bot info
  out.bot = {
    uptime: process.uptime(),
    node: process.version,
    pid: process.pid,
    memMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    guilds: client.guilds.cache.size,
    users: client.users.cache.size,
  };

  // 🛰️ Discord WebSocket
  out.discord = {
    ping: Math.round(client.ws.ping),
    status: client.ws.status,
    lastHeartbeat: Date.now() - (client.ws.shards.first()?.lastPingTimestamp || 0),
  };

  // 🧠 HLDS UDP
  out.hlds = {
    port: Number(env.HL_LOG_PORT || 27500),
    allowed: (env.HL_ALLOWED_SOURCE || "").split(",").filter(Boolean),
    lastPacketAge: global.lastHldsPacketAt
      ? ((Date.now() - global.lastHldsPacketAt) / 1000).toFixed(1) + "s"
      : "n/a",
  };

  // 🌐 SFTP (logs directory)
  if (env.HL_SSH_HOST) {
    const sftp = new Client();
    const start = Date.now();
    try {
      await withTimeout(
        sftp.connect({
          host: env.HL_SSH_HOST,
          port: Number(env.HL_SSH_PORT || 22),
          username: env.HL_SSH_USER,
          password: env.HL_SSH_PASS,
          readyTimeout: SFTP_CONNECT_MS,
        }),
        SFTP_CONNECT_MS + 500,
        "sftp.connect"
      );

      const files = await withTimeout(
        sftp.list(env.HL_REMOTE_LOG_DIR || "."),
        SFTP_LIST_MS,
        "sftp.list"
      );
      await sftp.end().catch(() => {});
      out.sftp = { ok: true, count: files.length, ms: Date.now() - start };
    } catch (err) {
      out.sftp = { ok: false, error: err.message };
    }
  }

  // ⚙️ Hampalyzer endpoint health
  if (env.HAMPALYZER_BASE) {
    try {
      const start = Date.now();
      const res = await fetchWithTimeout(env.HAMPALYZER_BASE, { method: "HEAD" }, HTTP_TIMEOUT_MS);
      out.hampalyzer = { ok: res.ok, status: res.status, ms: Date.now() - start };
    } catch (err) {
      out.hampalyzer = { ok: false, error: err.message };
    }
  }

  // 💾 DB + Disk stats
  out.db = {};
  ["elo.db", "queue.json"].forEach(f => {
    try {
      const stat = fs.statSync(f);
      out.db[f] = Math.round(stat.size / 1024) + " KB";
    } catch {}
  });

  try {
    if (os.platform() !== "win32") {
      const df = execSync("df -h .").toString().split("\n")[1] || "";
      out.disk = df.trim();
    } else {
      out.disk = `FreeMem ~${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB`;
    }
  } catch (err) {
    out.disk = { error: err.message };
  }

  // 🧮 CPU info
  out.cpu = {
    load: os.loadavg().map(x => x.toFixed(2)),
    cores: os.cpus().length,
  };

  return out;
}

/**
 * Format health data for Discord.
 */
function formatDiscord(h) {
  const lines = [
    `**Health — TFCBot**`,
    `• Uptime: ${fmtUptime(h.bot.uptime)} • Node: ${h.bot.node} • PID: ${h.bot.pid}`,
    `• Mem: ${h.bot.memMb} MB • Guilds: ${h.bot.guilds} • Cached Users: ${h.bot.users}`,
    `• Discord: ping ${h.discord.ping}ms • ws ${h.discord.status}`,
    `• HLDS UDP :${h.hlds.port} • allowed [${h.hlds.allowed.join(", ")}] • last ${h.hlds.lastPacketAge}`,
  ];

  if (h.sftp) lines.push(`• SFTP: ${h.sftp.ok ? `✅ ${h.sftp.count} files (${h.sftp.ms}ms)` : `❌ ${h.sftp.error}`}`);
  if (h.hampalyzer) lines.push(`• Hampalyzer: ${h.hampalyzer.ok ? `✅ ${h.hampalyzer.status} (${h.hampalyzer.ms}ms)` : `❌ ${h.hampalyzer.error}`}`);
  if (h.db) lines.push(`• DB: ${Object.entries(h.db).map(([k, v]) => `${k}:${v}`).join(" • ")}`);
  if (h.disk) lines.push(`• Disk: ${typeof h.disk === "string" ? h.disk : JSON.stringify(h.disk)}`);
  if (h.cpu) lines.push(`• CPU: load ${h.cpu.load.join(", ")} • cores ${h.cpu.cores}`);

  return lines.join("\n");
}

function fmtUptime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

module.exports = { gatherHealth, formatDiscord };
