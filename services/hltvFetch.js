// services/hltvFetch.js
"use strict";

const SftpClient = require("ssh2-sftp-client");
const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");
const { createHandoff, finalizeDemo, publishHandoff } = require("./hltvHandoff");

/* -------------------------------------------------------------------------- */
/* 🌍 Multi-server aware config                                               */
/* -------------------------------------------------------------------------- */
function getSftpConfig(serverKey = "east") {
  const key = serverKey.toUpperCase();
  return {
    host: process.env[`HL_SSH_HOST_${key}`] || process.env.HL_SSH_HOST,
    port: Number(process.env.HL_SSH_PORT || 22),
    username: process.env.HL_SSH_USER,
    password: process.env.HL_SSH_PASS,
    hltvDir:
      process.env[`HL_REMOTE_HLTV_DIR_${key}`] ||
      process.env.HL_REMOTE_HLTV_DIR ||
      "HLTVEAST",
  };
}

function tmpDir(prefix = "hltv") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function extractMapName(filename) {
  const noExt = filename.replace(/\.dem$/i, "");
  const parts = noExt.split("-");
  return parts.length >= 2 ? parts[parts.length - 1] : noExt;
}

/* -------------------------------------------------------------------------- */
/* 🎞️ Fetch + zip recent HLTV demos                                          */
/* -------------------------------------------------------------------------- */
async function fetchAndZipRecentDemos(opts = {}) {
  const {
    lookback = 10,
    requiredCount = 2,
    mapName,
    server = "east", // 👈 NEW
  } = opts;

  const cfg = getSftpConfig(server);
  if (!cfg.host || !cfg.username || !cfg.hltvDir) {
    throw new Error("Missing HL_* env vars (HL_SSH_HOST / USER / HL_REMOTE_HLTV_DIR)");
  }

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      readyTimeout: 20000,
    });

    console.log(`[HLTV] Connected to ${cfg.host} (${server})`);
    console.log(`[HLTV] Listing directory: ${cfg.hltvDir}`);

    let list = await sftp.list(cfg.hltvDir);
    let demFiles = list
      .filter(f => /\.dem$/i.test(f.name))
      .map(f => ({
        name: f.name,
        modifyTime: f.modifyTime || 0,
        size: f.size || 0,
      }));

    // 🔹 Filter out small demos (<4MB)
    const minBytes = 4_000_000;
    demFiles = demFiles.filter(f => f.size >= minBytes);
    if (!demFiles.length) throw new Error("NO_DEMOS");

    demFiles.sort((a, b) => (b.modifyTime || 0) - (a.modifyTime || 0));
    demFiles = demFiles.slice(0, lookback);

    const mapGroups = demFiles.reduce((acc, f) => {
      const map = extractMapName(f.name).toLowerCase();
      (acc[map] ||= []).push(f);
      return acc;
    }, {});

    const prefer = mapName ? mapName.toLowerCase() : null;
    let chosenMap = prefer && mapGroups[prefer]?.length >= requiredCount
      ? prefer
      : Object.entries(mapGroups)
          .filter(([, files]) => files.length >= requiredCount)
          .sort((a, b) => b[1].length - a[1].length)[0]?.[0];

    if (!chosenMap) throw new Error("NO_DEMOS");

    const chosenFiles = mapGroups[chosenMap]
      .sort((a, b) => (b.modifyTime || 0) - (a.modifyTime || 0))
      .slice(0, requiredCount);

    let handoff = null;
    try { handoff = createHandoff(opts); } catch (error) {
      // Registry failure must never break existing Discord delivery.
      console.error("[HLTV registry] handoff unavailable:", error.message);
    }
    const workdir = handoff?.dir || tmpDir(`hltv-${server}`);
    const downloaded = [];
    for (const f of chosenFiles) {
      if (path.basename(f.name) !== f.name || f.name.includes("\\")) throw new Error("Unsafe remote demo filename");
      const remotePath = `${cfg.hltvDir}/${f.name}`;
      const localPath = path.join(workdir, f.name);
      await sftp.fastGet(remotePath, localPath + ".part");
      fs.renameSync(localPath + ".part", localPath);
      try { finalizeDemo(handoff, localPath, f); } catch (error) {
        console.error("[HLTV registry] registration deferred; original retained:", error.message);
      }
      downloaded.push({ remotePath, filename: f.name, localPath });
    }

    const zipPath = path.join(workdir, `hltv_${chosenMap}_${Date.now()}.zip`);
    await zipFiles(downloaded.map(d => d.localPath), zipPath);
    try { publishHandoff(handoff); } catch (error) {
      console.error("[HLTV registry] manifest publication deferred; original retained:", error.message);
    }

    await sftp.end();
    return { zipPath, demos: downloaded, map: chosenMap, tmpDir: workdir, server, retained: Boolean(handoff) };
  } catch (err) {
    try { await sftp.end(); } catch {}
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* 🗜️ Helpers                                                                 */
/* -------------------------------------------------------------------------- */
function zipFiles(files, targetZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    files.forEach(f => archive.file(f, { name: path.basename(f) }));
    archive.finalize();
  });
}

function cleanupResult(result) {
  if (!result?.tmpDir) return;
  if (result.retained) {
    // Only the ZIP is transient. Raw demos/manifests belong to retention now.
    try { if (result.zipPath) fs.unlinkSync(result.zipPath); } catch {}
    return;
  }
  try { fs.rmSync(result.tmpDir, { recursive: true, force: true }); } catch {}
}

/* -------------------------------------------------------------------------- */
module.exports = { fetchAndZipRecentDemos, cleanupResult };
