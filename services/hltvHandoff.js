"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

// This is a destination for the EXISTING download, never another downloader.
function createHandoff(opts, env = process.env) {
  if (env.HLTV_REGISTRY_ENABLED !== "true" || !opts.matchId) return null;
  if (!env.HLTV_STORAGE_ROOT || !path.isAbsolute(env.HLTV_STORAGE_ROOT)) throw new Error("HLTV_STORAGE_ROOT must be absolute");
  const root = path.resolve(env.HLTV_STORAGE_ROOT);
  const inside = (base, target) => { const r = path.relative(base, target); return !r || (r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r)); };
  if (inside(path.resolve(__dirname, ".."), root) || (env.HLTV_PUBLIC_ROOT && inside(path.resolve(env.HLTV_PUBLIC_ROOT), root))) throw new Error("HLTV storage must be outside code/public roots");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error("Unsafe HLTV root");
  const incoming = path.join(root, "incoming");
  fs.mkdirSync(incoming, { mode: 0o700, recursive: true });
  if (fs.lstatSync(incoming).isSymbolicLink()) throw new Error("Unsafe HLTV incoming directory");
  const free = fs.statfsSync(root);
  const minimum = Number(env.HLTV_MIN_DISK_FREE_BYTES || 10737418240);
  if (!Number.isSafeInteger(minimum) || minimum < 0 || free.bavail * free.bsize < minimum) throw new Error("HLTV storage headroom unavailable");
  const dir = path.join(incoming, crypto.randomUUID());
  fs.mkdirSync(dir, { mode: 0o700 });
  console.log(`[HLTV registry] Retaining original downloads for match ${opts.matchId} (${opts.server || "east"}) in ${dir}`);
  return { root, dir, manifest: { version: 1, match_id: String(opts.matchId), server: opts.server || "east", map: opts.mapName || null, demos: [] } };
}
function finalizeDemo(handoff, localPath, remote, env = process.env) {
  if (!handoff) return;
  const stat = fs.lstatSync(localPath);
  const max = Number(env.HLTV_MAX_DEMO_BYTES || 268435456);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size !== remote.size || stat.size > max) throw new Error("HLTV incomplete or oversized demo");
  handoff.manifest.demos.push({ storage_key: path.relative(handoff.root, localPath).split(path.sep).join("/"),
    filename: remote.name, recorded_at: remote.modifyTime || Date.now(), round_id: null });
  const manifest = path.join(handoff.dir, "pending.json");
  const temporary = manifest + ".tmp";
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(handoff.manifest)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, manifest);
}
function publishHandoff(handoff) {
  if (!handoff || !handoff.manifest.demos.length) return;
  fs.renameSync(path.join(handoff.dir, "pending.json"), path.join(handoff.dir, "ready.json"));
  console.log(`[HLTV registry] Published ${handoff.manifest.demos.length} retained demos for match ${handoff.manifest.match_id}`);
}
function logCollectionStatus(env = process.env, logger = console) {
  logger.log(`[HLTV registry] Collection ${env.HLTV_REGISTRY_ENABLED === "true" ? "enabled" : "disabled"}; storage=${env.HLTV_STORAGE_ROOT || "not configured"}; awaiting existing match recap downloads`);
}
module.exports = { createHandoff, finalizeDemo, publishHandoff, logCollectionStatus };
