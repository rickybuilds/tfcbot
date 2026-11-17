"use strict";
const fs = require("fs");
const HEADER_BYTES = 544, ENTRY_BYTES = 92;
function finalizationConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid " + key);
    return value;
  };
  return { enabled: env.HLTV_FINALIZATION_CHECK_ENABLED === "true",
    timeoutMs: number("HLTV_FINALIZATION_WAIT_MS", 120000, 1000, 600000), pollMs: 2000,
    maxBytes: number("HLTV_MAX_DEMO_BYTES", 268435456, HEADER_BYTES, 2147483647) };
}
function inspectHeader(header, size, map) {
  const info = { finalized: false, size, directory_offset: null, map: null };
  if (header.length !== HEADER_BYTES || header.subarray(0, 6).toString() !== "HLDEMO") return { ...info, reason: "invalid_demo_header" };
  info.map = header.subarray(16, 276).toString().split("\0")[0];
  info.directory_offset = header.readInt32LE(540);
  if (map && info.map.toLowerCase() !== map.toLowerCase()) return { ...info, reason: "wrong_map" };
  if (info.directory_offset === 0) return { ...info, reason: "unfinalized_demo" };
  if (info.directory_offset <= HEADER_BYTES || info.directory_offset + 4 > size) return { ...info, reason: "invalid_demo_directory" };
  return info;
}
function validDirectory(directory, offset, size) {
  if (directory.length < 4) return false;
  const count = directory.readInt32LE(0);
  if (count < 1 || count > 1024 || directory.length !== 4 + count * ENTRY_BYTES || offset + directory.length > size) return false;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * ENTRY_BYTES, start = directory.readInt32LE(at + 84), length = directory.readInt32LE(at + 88);
    if (start < HEADER_BYTES || length < 0 || start + length > offset) return false;
  }
  return true;
}
const sameStat = (a, b) => a.size === b.size && a.modifyTime === b.modifyTime;
async function range(sftp, name, start, length) {
  const bytes = await sftp.get(name, undefined, { readStreamOptions: { start, end: start + length - 1 } });
  if (!Buffer.isBuffer(bytes) || bytes.length !== length) throw new Error("HLTV_SHORT_SOURCE_READ");
  return bytes;
}
async function inspectRemote(sftp, name, map, maxBytes) {
  const before = await sftp.stat(name);
  if (!before.isFile || !Number.isSafeInteger(before.size) || before.size < HEADER_BYTES || before.size > maxBytes) return { finalized: false, reason: "invalid_source_size_or_type", size: before.size };
  const header = await range(sftp, name, 0, HEADER_BYTES), info = inspectHeader(header, before.size, map);
  if (info.reason) return info;
  const countBytes = await range(sftp, name, info.directory_offset, 4), count = countBytes.readInt32LE(0);
  if (count < 1 || count > 1024 || info.directory_offset + 4 + count * ENTRY_BYTES > before.size) return { ...info, reason: "invalid_demo_directory" };
  const entries = await range(sftp, name, info.directory_offset + 4, count * ENTRY_BYTES), directory = Buffer.concat([countBytes, entries]);
  if (!validDirectory(directory, info.directory_offset, before.size)) return { ...info, reason: "invalid_demo_directory" };
  const after = await sftp.stat(name);
  if (!sameStat(before, after)) return { ...info, reason: "source_changed" };
  return { ...info, finalized: true, reason: "finalized", modifyTime: after.modifyTime, header, directory };
}
async function probeRemoteDemo(sftp, name, map, options = {}) {
  let timer;
  try {
    return await Promise.race([inspectRemote(sftp, name, map, options.maxBytes || 268435456), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("HLTV_SOURCE_CHECK_TIMEOUT")), options.requestTimeoutMs || 15000);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForFinalized(sftp, name, map, options = {}) {
  const now = options.now || Date.now, sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 120000);
  for (;;) {
    const result = await probeRemoteDemo(sftp, name, map, { ...options, requestTimeoutMs: Math.max(1, Math.min(15000, deadline - now())) });
    if (result.finalized) return result;
    if (!["unfinalized_demo", "source_changed", "invalid_demo_directory"].includes(result.reason)) throw new Error("HLTV_SOURCE_REJECTED: " + result.reason);
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("HLTV_NOT_FINALIZED: " + result.reason);
    await sleep(Math.min(options.pollMs ?? 2000, remaining));
  }
}
function verifyDownloaded(filename, snapshot) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd), header = Buffer.alloc(HEADER_BYTES), directory = Buffer.alloc(snapshot.directory.length);
    if (!stat.isFile() || stat.size !== snapshot.size || fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(snapshot.header) ||
        fs.readSync(fd, directory, 0, directory.length, snapshot.directory_offset) !== directory.length || !directory.equals(snapshot.directory)) throw new Error("HLTV_DOWNLOAD_CHANGED_OR_INCOMPLETE");
  } finally { fs.closeSync(fd); }
}
module.exports = { finalizationConfig, inspectHeader, probeRemoteDemo, waitForFinalized, verifyDownloaded, sameStat };
