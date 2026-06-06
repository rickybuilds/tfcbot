// services/hldsTransfer.js
"use strict";

/* -------------------------------------------------------------------------- */
/* 🚚 HLDS Log Transfer + Upload (SFTP → Hampalyzer + TFCStats)               */
/* -------------------------------------------------------------------------- */
/**
 * Install dependencies:
 *   npm i ssh2-sftp-client node-fetch@2 form-data
 */

const fs = require("fs");
const path = require("path");
const SFTPClient = require("ssh2-sftp-client");
const fetch = require("node-fetch");
const FormData = require("form-data");

/* -------------------------------------------------------------------------- */
/* 🌍 Config + Defaults                                                       */
/* -------------------------------------------------------------------------- */
const MIN_KB = Number(process.env.HL_MIN_LOG_KB || 80);
const TMP_DIR = path.join(process.cwd(), "tmp", "hlds-logs");

const HAMP_BASE = process.env.HAMPALYZER_BASE || "https://app.hampalyzer.com";
const UPLOAD_URL = process.env.HAMPALYZER_UPLOAD_URL || `${HAMP_BASE}/api/parseGame`;
const TFCSTATS_BASE = process.env.TFCSTATS_BASE || "https://www.tfcstats.com/pickup";
const TFCSTATS_UPLOAD_URL =
  process.env.TFCSTATS_UPLOAD_URL ||
  "https://www.tfcstats.com/api/parsePickup?skipAwards=true";
const API_KEY = process.env.HAMPALYZER_API_KEY || "";

/* -------------------------------------------------------------------------- */
/* 🧱 Helpers                                                                 */
/* -------------------------------------------------------------------------- */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function detectMapInLog(filePath) {
  try {
    const firstLines = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .slice(0, 20);
    for (const line of firstLines) {
      const m =
        line.match(/Loading map "([^"]+)"/i) ||
        line.match(/Started map "([^"]+)"/i);
      if (m) return m[1];
    }
  } catch (e) {
    console.error("[hldsTransfer] detectMapInLog failed:", filePath, e.message);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 🔐 Multi-Server Aware SFTP Connector                                       */
/* -------------------------------------------------------------------------- */
async function sftpConnect(serverKey = "east") {
  const key = serverKey.toUpperCase();
  const sftp = new SFTPClient();

  const cfg = {
    host:
      process.env[`HL_SSH_HOST_${key}`] ||
      process.env.HL_SSH_HOST ||
      "127.0.0.1",
    port: Number(process.env.HL_SSH_PORT || 22),
    username: process.env.HL_SSH_USER || "steam",
    password: process.env.HL_SSH_PASS || process.env.HL_SSH_PASSWORD || "",
  };

  console.log(`[SFTP] Connecting to ${cfg.host}:${cfg.port} (${serverKey})...`);
  await sftp.connect(cfg);
  console.log(`[SFTP] Connected to ${cfg.host} (${serverKey})`);
  return sftp;
}

/* -------------------------------------------------------------------------- */
/* 📥 Download Logs via SFTP                                                  */
/* -------------------------------------------------------------------------- */
async function downloadLogs({ filenames, matchId, map, minKb = MIN_KB, server }) {
  const serverKey = server || "east";
  const sftp = await sftpConnect(serverKey);
  const kept = [];
  const skipped = [];
  const localPaths = [];

  try {
    const base =
      process.env[`HL_REMOTE_LOG_DIR_${serverKey.toUpperCase()}`] ||
      process.env.HL_REMOTE_LOG_DIR ||
      "/root/steamcmd/tfc/tfc/logs";

    const hltvDir =
      process.env[`HL_REMOTE_HLTV_DIR_${serverKey.toUpperCase()}`] ||
      process.env.HL_REMOTE_HLTV_DIR ||
      "HLTVEAST";

    const workDir = ensureDir(path.join(TMP_DIR, `${serverKey}-${matchId || "unknown"}`));

    console.log(  `[SFTP:${serverKey}] Listing remote log dir: ${base}`);
    let remoteFiles = await sftp.list(base);
    remoteFiles = remoteFiles
      .filter(f => f.name.endsWith(".log"))
      .sort((a, b) => b.modifyTime - a.modifyTime);

    console.log(`[SFTP:${serverKey}] Found ${remoteFiles.length} log files in ${base}`);

    const cutoff = Date.now() - 2 * 60 * 60 * 1000; // 2h
    const eligible = [];

    for (const f of remoteFiles) {
      const sizeKb = Math.round(f.size / 1024);
      const mtime = f.modifyTime * 1000;

      if (mtime < cutoff) continue;
      if (sizeKb < minKb) {
        skipped.push(`${f.name} (${sizeKb}KB < ${minKb}KB)`);
        continue;
      }

      const remotePath = `${base}/${f.name}`;
      const local = path.join(workDir, f.name);
      console.log(`[SFTP:${serverKey}] Downloading ${remotePath} -> ${local}`);
      await sftp.fastGet(remotePath, local);
      console.log(`[SFTP:${serverKey}] Downloaded ${f.name}`);

      const detectedMap = detectMapInLog(local);
      if (
        detectedMap &&
        detectedMap.toLowerCase() === String(map || "").toLowerCase()
      ) {
        eligible.push({ local, fname: f.name, sizeKb, map: detectedMap });
      } else {
        skipped.push(`${f.name} (wrong map: ${detectedMap || "unknown"})`);
        try {
          fs.unlinkSync(local);
        } catch {}
      }

      if (eligible.length >= 2) break;
    }

    // Expand search if not enough valid logs
    if (eligible.length < 2) {
      console.warn(`[SFTP:${serverKey}] Only ${eligible.length} valid logs — expanding search`);
      for (const f of remoteFiles) {
        if (eligible.find(e => e.fname === f.name)) continue;
        const remotePath = `${base}/${f.name}`;
        const local = path.join(workDir, f.name);

        console.log(`[SFTP:${serverKey}] Downloading ${remotePath} -> ${local}`);
        await sftp.fastGet(remotePath, local);
        console.log(`[SFTP:${serverKey}] Downloaded ${f.name}`);
        const detectedMap = detectMapInLog(local);
        if (
          detectedMap &&
          detectedMap.toLowerCase() === String(map || "").toLowerCase()
        ) {
          eligible.push({ local, fname: f.name, sizeKb: Math.round(f.size / 1024), map: detectedMap });
          if (eligible.length >= 2) break;
        } else {
          try { fs.unlinkSync(local); } catch {}
        }
      }
    }

    for (const e of eligible.sort((a, b) => a.fname.localeCompare(b.fname))) {
      kept.push(`${e.fname} (${e.sizeKb}KB, map=${e.map})`);
      localPaths.push(e.local);
    }
  } finally {
    try { await sftp.end(); } catch {}
  }

  return { localPaths, kept, skipped };
}

/* -------------------------------------------------------------------------- */
/* ☁️ Upload to Hampalyzer                                                    */
/* -------------------------------------------------------------------------- */
async function uploadToHampalyzer({ paths, matchId, map, extra = {} }) {
  if (!paths.length) return { ok: false, status: 0, text: "no files" };

  const form = new FormData();
  form.append("force", "on");
  form.append("matchId", String(matchId || ""));
  form.append("map", String(map || ""));
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null) form.append(k, String(v));
  }

  const sorted = [...paths].sort((a, b) => {
    const getNum = f => {
      const m = path.basename(f).match(/L(\d+)\.log/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    return getNum(a) - getNum(b);
  });

  console.log(`[HAMPALYZER] Uploading ${sorted.length} log(s)`);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const original = path.basename(p);
    const renamed = `nonamepickups-R${i + 1}-${original}`;
    form.append("logs[]", fs.createReadStream(p), renamed);
  }

  const headers = { ...form.getHeaders() };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  try {
    const res = await fetch(UPLOAD_URL, { method: "POST", headers, body: form });
    const raw = await res.text().catch(() => "");
    let trimmed = raw.trim().replace(/"/g, "");
    if (trimmed.includes("path:")) {
      const m = trimmed.match(/path:([^}]+)}/i);
      if (m && m[1]) trimmed = m[1].trim();
    }

    let url = null;
    if (/^https?:\/\//i.test(trimmed)) url = trimmed;
    else if (trimmed) url = `${HAMP_BASE}/${trimmed.replace(/^\/+/, "")}`;

    console.log(`[HAMPALYZER] Response ${res.status}: ${url || "no url"}`);

    for (const p of paths) try { fs.unlinkSync(p); } catch {}

    return { ok: res.ok, status: res.status, text: raw, url };
  } catch (err) {
    console.error("[HAMPALYZER ERROR]", err);
    return { ok: false, status: 0, text: String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* ☁️ Upload to TFCStats                                                     */
/* -------------------------------------------------------------------------- */
async function uploadToTFCStats({ paths, matchId, map }) {
  if (!paths.length) return { ok: false, status: 0, text: "no files" };

  const form = new FormData();
  form.append("force", "on");
  form.append("matchId", String(matchId || ""));
  form.append("map", String(map || ""));

  const sorted = [...paths].sort((a, b) => {
    const getNum = f => {
      const m = path.basename(f).match(/L(\d+)\.log/i);
      return m ? parseInt(m[1], 10) : 0;
    };
    return getNum(a) - getNum(b);
  });

  console.log(`[TFCSTATS] Uploading ${sorted.length} log(s)`);
  for (const p of sorted) {
    const original = path.basename(p);
    const renamed = `nonamepickups-${matchId || "unknown"}-${original}`;
    form.append("logs[]", fs.createReadStream(p), renamed);
  }

  try {
    const res = await fetch(TFCSTATS_UPLOAD_URL, { method: "POST", body: form, headers: form.getHeaders() });
    const raw = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    const url = json?.success?.path || null;

    console.log(`[TFCSTATS] Response ${res.status}: ${url || "no url"}`);
    return { ok: res.ok, status: res.status, url, text: raw };
  } catch (err) {
    console.error("[TFCSTATS ERROR]", err);
    return { ok: false, status: 0, text: String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/* 🔁 End-to-End Pipeline (Download → Uploads)                                */
/* -------------------------------------------------------------------------- */
async function downloadAndUploadLogs({ filenames, matchId, map, minKb, extra, server }) {
  const dl = await downloadLogs({
    filenames,
    matchId,
    map,
    minKb: typeof minKb === "number" ? minKb : MIN_KB,
    server,
  });
  if (!dl.localPaths.length) return { stage: "download", ...dl };

  const upStats = await uploadToTFCStats({ paths: dl.localPaths, matchId, map });
  const upHamp = await uploadToHampalyzer({ paths: dl.localPaths, matchId, map, extra });

  return { stage: "upload", ...dl, upload: upHamp, tfcstats: upStats };
}

/* -------------------------------------------------------------------------- */
module.exports = {
  downloadLogs,
  uploadToHampalyzer,
  uploadToTFCStats,
  downloadAndUploadLogs,
};
