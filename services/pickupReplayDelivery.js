"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sshCommand(host, user, port, command) {
  if (!host || !/^[a-zA-Z0-9.:_-]+$/.test(host) || host.startsWith("-")) return Promise.reject(new Error("Invalid delivery SSH host"));
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) return Promise.reject(new Error("Invalid delivery SSH user"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("Invalid delivery SSH port"));
  const key = process.env.PICKUP_DELIVERY_SSH_KEY;
  if (!key || !fs.existsSync(key)) return Promise.reject(new Error("Missing PICKUP_DELIVERY_SSH_KEY"));
  const args = ["-T", "-i", key, "-p", String(port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${process.env.PICKUP_DELIVERY_KNOWN_HOSTS || path.join(os.homedir(), ".ssh", "known_hosts")}`,
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", `${user}@${host}`, command];
  return new Promise((resolve, reject) => execFile("ssh", args, { timeout: 15 * 60 * 1000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Delivery SSH failed: ${String(stderr || error.message).slice(-1500)}`));
    else resolve(stdout);
  }));
}

class PickupReplayDelivery {
  constructor({ db, servers, isBusy, enabled = /^(1|true)$/i.test(process.env.PICKUP_DELIVERY_ENABLED || ""), logger = console }) {
    this.db = db;
    this.servers = servers;
    this.isBusy = isBusy;
    this.enabled = enabled;
    this.logger = logger;
    this.running = false;
    this.activeRecaps = new Set();
    if (!enabled) return;
    db.exec(`CREATE TABLE IF NOT EXISTS pickup_replay_delivery_jobs (
      server_key TEXT NOT NULL, match_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'upload',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(server_key,match_id));`);
    this.timer = setInterval(() => this.tick().catch(err => logger.error("[replay-delivery]", err.message)), 30000);
    this.timer.unref();
    setImmediate(() => this.tick().catch(err => logger.error("[replay-delivery]", err.message)));
  }

  begin(serverKey, matchId) {
    if (!this.enabled) return;
    if (!this.servers[serverKey] || !/^[a-z0-9_-]{1,64}$/i.test(matchId)) throw new Error("Invalid replay delivery identity");
    this.activeRecaps.add(`${serverKey}:${matchId}`);
    this.db.prepare(`INSERT INTO pickup_replay_delivery_jobs(server_key,match_id,phase,next_attempt,updated_at)
      VALUES(?,?,'finalize',?,?) ON CONFLICT(server_key,match_id) DO NOTHING`)
      .run(serverKey, matchId, Date.now() + 120000, Date.now());
  }

  enqueue(serverKey, matchId) {
    if (!this.enabled) return;
    this.activeRecaps.delete(`${serverKey}:${matchId}`);
    this.db.prepare(`UPDATE pickup_replay_delivery_jobs SET next_attempt=0,updated_at=?
      WHERE server_key=? AND match_id=? AND phase='finalize'`).run(Date.now(), serverKey, matchId);
    setImmediate(() => this.tick().catch(err => this.logger.error("[replay-delivery]", err.message)));
  }
  hostBusy(host) {
    // Logical servers sharing a machine also share compression/network resources.
    for (const [key, config] of Object.entries(this.servers)) {
      if (config.trackingOnly || config.ssh?.host !== host) continue;
      if (this.isBusy(key)) return true;
      // Fail closed across a bot restart: a started, unfinished match stays busy.
      const active = this.db.prepare(`SELECT 1 FROM pickup_replay_recordings r JOIN matches m ON m.match_id=r.match_id
        WHERE r.server_key=? AND r.started_at IS NOT NULL AND m.status='in_progress'
        AND NOT EXISTS (SELECT 1 FROM pickup_replay_recordings done
          WHERE done.server_key=r.server_key AND done.match_id=r.match_id AND done.round_number=2
          AND done.observed_state='ready' AND done.stopped_at IS NOT NULL) LIMIT 1`).get(key);
      if (active) return true;
    }
    return false;
  }

  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const jobs = this.db.prepare("SELECT * FROM pickup_replay_delivery_jobs WHERE phase<>'done' AND next_attempt<=? ORDER BY updated_at").all(Date.now());
      for (const job of jobs) {
        try {
          const server = this.servers[job.server_key];
          if (!server?.ssh?.host) throw new Error(`No SSH host configured for ${job.server_key}`);
          if (job.phase === "finalize") {
            if (this.activeRecaps.has(`${job.server_key}:${job.match_id}`)) continue;
            const ready = this.db.prepare(`SELECT round_number FROM pickup_replay_recordings
              WHERE server_key=? AND match_id=? AND observed_state='ready' AND stopped_at IS NOT NULL`).all(job.server_key, job.match_id);
            const match = this.db.prepare("SELECT status FROM matches WHERE match_id=?").get(job.match_id);
            if (match?.status !== "completed" || ![1,2].every(round => ready.some(row => row.round_number === round))) continue;
            this.db.prepare("UPDATE pickup_replay_delivery_jobs SET phase='upload' WHERE server_key=? AND match_id=?").run(job.server_key, job.match_id);
            job.phase = "upload";
          }
          if (job.phase === "upload") {
            if (this.hostBusy(server.ssh.host)) continue;
            this.logger.log(`[replay-delivery] ${job.match_id}: starting upload on ${job.server_key}`);
            await sshCommand(server.ssh.host, process.env.PICKUP_DELIVERY_SSH_USER || "root", Number(process.env.PICKUP_DELIVERY_SSH_PORT || server.ssh.port || 22), `upload ${job.match_id}`);
            // Discovery requires recordings to be 30 seconds past verification.
            this.db.prepare("UPDATE pickup_replay_delivery_jobs SET phase='import',attempts=0,next_attempt=?,last_error=NULL,updated_at=? WHERE server_key=? AND match_id=?")
              .run(Date.now() + 35000, Date.now(), job.server_key, job.match_id);
            this.logger.log(`[replay-delivery] ${job.match_id}: upload verified; import queued`);
          } else {
            const webHost = process.env.PICKUP_DELIVERY_WEB_HOST;
            if (!webHost) throw new Error("Missing PICKUP_DELIVERY_WEB_HOST");
            await sshCommand(webHost, process.env.PICKUP_DELIVERY_WEB_USER || "root", Number(process.env.PICKUP_DELIVERY_WEB_PORT || 22), `maintain ${job.match_id}`);
            this.db.prepare("UPDATE pickup_replay_delivery_jobs SET phase='done',last_error=NULL,updated_at=? WHERE server_key=? AND match_id=?")
              .run(Date.now(), job.server_key, job.match_id);
            this.logger.log(`[replay-delivery] ${job.match_id}: details ready`);
          }
        } catch (error) {
          const delay = Math.min(15 * 60000, 30000 * 2 ** Math.min(job.attempts, 5));
          this.db.prepare("UPDATE pickup_replay_delivery_jobs SET attempts=attempts+1,next_attempt=?,last_error=?,updated_at=? WHERE server_key=? AND match_id=?")
            .run(Date.now() + delay, error.message.slice(0, 2000), Date.now(), job.server_key, job.match_id);
          this.logger.error(`[replay-delivery] ${job.match_id}: ${error.message}; retry queued`);
        }
      }
    } finally { this.running = false; }
  }
}
module.exports = { PickupReplayDelivery };
