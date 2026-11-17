"use strict";
// Read-only comparison with the ORIGINAL HLTV servers; never downloads full demos.
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env"), quiet: true });
const fs = require("fs"), path = require("path"), SftpClient = require("ssh2-sftp-client");
const { getSftpConfig } = require("../services/hltvFetch");
const { finalizationConfig, inspectHeader, probeRemoteDemo } = require("../services/hltvFinalization");
async function main() {
  const args = process.argv.slice(2), match = args[0] === "--match" && args.length === 2 && /^[A-Za-z0-9_-]{1,100}$/.test(args[1]) ? args[1] : null;
  if (!match && !(args.length === 1 && args[0] === "--all-failed")) throw new Error("Usage: node scripts/checkHltvSources.js --all-failed | --match MATCH_ID (read-only)");
  if (process.env.HLTV_REGISTRY_ENABLED !== "true" || !process.env.HLTV_REGISTRY_DB || !process.env.HLTV_STORAGE_ROOT) throw new Error("HLTV registry paths must be configured");
  const root = fs.realpathSync(process.env.HLTV_STORAGE_ROOT), options = finalizationConfig();
  const db = require("better-sqlite3")(process.env.HLTV_REGISTRY_DB, { readonly: true, fileMustExist: true });
  let rows;
  try {
    const recoveryTable=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hltv_source_recoveries'").get();
    rows = db.prepare(`SELECT d.match_id,d.server,d.filename,${recoveryTable?"COALESCE(c.source_filename,d.filename)":"d.filename"} AS source_filename,d.map,d.storage_key,r.status FROM hltv_demos d
      ${recoveryTable?"LEFT JOIN hltv_source_recoveries c ON c.recovered_demo_id=d.id":""}
      LEFT JOIN hltv_upstream_runs r ON r.id=(SELECT id FROM hltv_upstream_runs WHERE demo_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1)
      WHERE d.file_status='available' AND ((? IS NOT NULL AND d.match_id=?) OR (? IS NULL AND r.status='failed'))
      ORDER BY d.server,d.match_id,d.filename LIMIT 100`).all(match, match, match);
  } finally { db.close(); }
  let sftp, server;
  try {
    for (const row of rows) {
      try {
        if (path.basename(row.source_filename) !== row.source_filename || row.source_filename.includes("\\")) throw new Error("Unsafe demo filename");
        const local = path.resolve(root, row.storage_key), relative = path.relative(root, local);
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || fs.realpathSync(local) !== local) throw new Error("Unsafe local source");
        const fd = fs.openSync(local, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let localInfo;
        try {
          const stat = fs.fstatSync(fd), header = Buffer.alloc(544);
          if (!stat.isFile()) throw new Error("Local source is not a file");
          const read = fs.readSync(fd, header, 0, 544, 0);
          localInfo = inspectHeader(header.subarray(0, read), stat.size, row.map);
        } finally { fs.closeSync(fd); }
        const cfg = getSftpConfig(row.server);
        if (!cfg.host || !cfg.username || !cfg.hltvDir) throw new Error("Missing SFTP configuration for " + row.server);
        if (!sftp || server !== row.server) {
          if (sftp) await sftp.end(); sftp = new SftpClient(); server = row.server;
          await sftp.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 20000 });
        }
        const remote = await probeRemoteDemo(sftp, `${cfg.hltvDir}/${row.source_filename}`, row.map, options);
        console.log(JSON.stringify({ match: row.match_id, server: row.server, file: row.filename,source_file:row.source_filename,
          local_bytes: localInfo.size, local_directory_offset: localInfo.directory_offset,
          remote_bytes: remote.size, remote_directory_offset: remote.directory_offset, remote_map: remote.map,
          remote_finalized: remote.finalized, reason: remote.reason,
          recovery_candidate: localInfo.reason === "unfinalized_demo" && remote.finalized }));
      } catch (error) {
        console.log(JSON.stringify({ match: row.match_id, server: row.server, file: row.filename, error: error.message }));
        if (sftp) { try { await sftp.end(); } catch {} sftp = null; server = null; }
      }
    }
    console.log(JSON.stringify({ checked: rows.length, read_only: true, full_demo_downloads: 0 }));
  } finally { if (sftp) await sftp.end(); }
}
main().catch(error => { console.error("[HLTV source check]", error.message); process.exitCode = 1; });
