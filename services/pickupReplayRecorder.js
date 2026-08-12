"use strict";

const MATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESPONSE_LENGTH = 1000;

function enabledFromEnv(value = process.env.PICKUP_RECORDING_ENABLED) {
  return /^(?:1|true|yes|on)$/i.test(String(value || ""));
}

function validateIdentity(matchId, roundNumber) {
  const id = String(matchId || "");
  const round = Number(roundNumber);
  if (!MATCH_ID_RE.test(id)) throw new Error("Unsafe pickup replay match ID");
  if (!Number.isInteger(round) || round < 1 || round > 9999) {
    throw new Error("Invalid pickup replay round number");
  }
  return { matchId: id, roundNumber: round };
}

function sanitizeResponse(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RESPONSE_LENGTH);
}

function responseIdentity(raw) {
  const text = sanitizeResponse(raw);
  const match = text.match(/(?:^|\s)(?:active_)?match_id=([A-Za-z0-9_-]{1,64})(?:\s|$)/i);
  const round = text.match(/(?:^|\s)(?:active_)?round=(\d{1,4})(?:\s|$)/i);
  return {
    matchId: match ? match[1] : null,
    roundNumber: round ? Number(round[1]) : null,
  };
}

function parseStatus(raw) {
  const text = sanitizeResponse(raw);
  const identity = responseIdentity(text);
  if (/\b(?:IDLE|NOT_RECORDING)\b/i.test(text) && !identity.matchId) {
    return { state: "idle", ...identity, raw: text };
  }
  if (identity.matchId && identity.roundNumber) {
    return { state: "recording", ...identity, raw: text };
  }
  return { state: "unknown", ...identity, raw: text };
}

function sameIdentity(parsed, identity) {
  return parsed.matchId === identity.matchId && parsed.roundNumber === identity.roundNumber;
}

class PickupReplayRecorder {
  constructor({ db, runRconCommand, enabled = enabledFromEnv(), retries = 3, logger = console } = {}) {
    if (!db) throw new Error("PickupReplayRecorder requires a SQLite database");
    if (typeof runRconCommand !== "function") throw new Error("PickupReplayRecorder requires RCON");
    this.db = db;
    this.runRconCommand = runRconCommand;
    this.enabled = Boolean(enabled);
    this.retries = Math.max(1, Number(retries) || 3);
    this.logger = logger;
    this.queues = new Map();
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pickup_replay_recordings (
        server_key TEXT NOT NULL,
        match_id TEXT NOT NULL,
        round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 9999),
        desired_state TEXT NOT NULL,
        observed_state TEXT NOT NULL DEFAULT 'unknown',
        start_attempts INTEGER NOT NULL DEFAULT 0,
        stop_attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        start_requested_at INTEGER,
        started_at INTEGER,
        stop_requested_at INTEGER,
        stopped_at INTEGER,
        last_response TEXT,
        last_error TEXT,
        PRIMARY KEY (server_key, match_id, round_number)
      );
      CREATE INDEX IF NOT EXISTS idx_pickup_replay_server_updated
        ON pickup_replay_recordings(server_key, updated_at DESC);
    `);
  }

  _enqueue(serverKey, operation) {
    const key = String(serverKey || "");
    if (!key) return Promise.reject(new Error("Missing game server identity"));
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(key, current);
    current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }).catch(() => {});
    return current;
  }

  _row(serverKey, identity) {
    return this.db.prepare(`
      SELECT * FROM pickup_replay_recordings
      WHERE server_key=? AND match_id=? AND round_number=?
    `).get(serverKey, identity.matchId, identity.roundNumber);
  }

  _ensureRow(serverKey, identity, desiredState) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO pickup_replay_recordings
        (server_key, match_id, round_number, desired_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_key, match_id, round_number) DO UPDATE SET
        desired_state=excluded.desired_state, updated_at=excluded.updated_at
    `).run(serverKey, identity.matchId, identity.roundNumber, desiredState, now, now);
  }

  _update(serverKey, identity, fields) {
    const allowed = new Set([
      "desired_state", "observed_state", "start_attempts", "stop_attempts",
      "start_requested_at", "started_at", "stop_requested_at", "stopped_at",
      "last_response", "last_error",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    entries.push(["updated_at", Date.now()]);
    const sql = entries.map(([key]) => `${key}=?`).join(", ");
    this.db.prepare(`UPDATE pickup_replay_recordings SET ${sql}
      WHERE server_key=? AND match_id=? AND round_number=?`)
      .run(...entries.map(([, value]) => value), serverKey, identity.matchId, identity.roundNumber);
  }

  _log(level, event, data) {
    const fn = typeof this.logger[level] === "function" ? this.logger[level] : this.logger.log;
    fn.call(this.logger, `[pickup-replay] ${JSON.stringify({ event, ...data })}`);
  }

  async _rconWithRetry(serverKey, command, identity, kind) {
    let lastError;
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const countColumn = kind === "start" ? "start_attempts" : "stop_attempts";
      const row = this._row(serverKey, identity);
      this._update(serverKey, identity, {
        [countColumn]: Number(row?.[countColumn] || 0) + 1,
        last_error: null,
      });
      try {
        return await this.runRconCommand(serverKey, command, 1);
      } catch (error) {
        lastError = sanitizeResponse(error?.message || error);
        this._update(serverKey, identity, { last_error: lastError });
        this._log(attempt < this.retries ? "warn" : "error", "rcon_retry", {
          serverKey, matchId: identity.matchId, roundNumber: identity.roundNumber,
          operation: kind, attempt, error: lastError,
        });
      }
    }
    throw new Error(`${kind} RCON failed after ${this.retries} attempts: ${lastError}`);
  }

  start(serverKey, matchId, roundNumber, options = {}) {
    if (!this.enabled) return Promise.resolve({ ok: true, disabled: true });
    let identity;
    try { identity = validateIdentity(matchId, roundNumber); }
    catch (error) { return Promise.reject(error); }
    const restart = options?.restart === true;
    return this._enqueue(serverKey, () => this._start(serverKey, identity, { restart }));
  }

  async _start(serverKey, identity, { restart = false } = {}) {
    this._ensureRow(serverKey, identity, "recording");
    const existing = this._row(serverKey, identity);
    if (!restart && existing?.observed_state === "recording") {
      return { ok: true, idempotent: true, state: "recording" };
    }
    this._update(serverKey, identity, { start_requested_at: Date.now() });
    this._log("info", "start_requested", { serverKey, ...identity, restart });
    const command = `amx_pr_start "${identity.matchId}" ${identity.roundNumber}`;
    const raw = await this._rconWithRetry(serverKey, command, identity, "start");
    const response = sanitizeResponse(raw);
    const parsed = responseIdentity(response);
    this._update(serverKey, identity, { last_response: response });

    if (/\bSTARTED\b/i.test(response) && sameIdentity(parsed, identity)) {
      this._update(serverKey, identity, { observed_state: "recording", started_at: Date.now(), last_error: null });
      this._log("info", "start_acknowledged", { serverKey, ...identity, restart });
      return { ok: true, state: "recording" };
    }
    if (/\bALREADY_RECORDING\b/i.test(response) && sameIdentity(parsed, identity)) {
      this._update(serverKey, identity, { observed_state: "recording", started_at: Date.now(), last_error: null });
      this._log("info", "already_recording", { serverKey, ...identity });
      return { ok: true, idempotent: true, state: "recording" };
    }
    const conflict = /\bREJECTED\b/i.test(response) ||
      (/\b(?:STARTED|ALREADY_RECORDING)\b/i.test(response) && !sameIdentity(parsed, identity));
    const message = conflict ? "Recorder active identity conflict" : `Recorder start failed: ${response}`;
    this._update(serverKey, identity, { observed_state: conflict ? "conflict" : "start_failed", last_error: message });
    this._log("error", conflict ? "active_identity_conflict" : "start_failed", { serverKey, ...identity, response });
    throw new Error(message);
  }

  stop(serverKey, matchId, roundNumber) {
    if (!this.enabled) return Promise.resolve({ ok: true, disabled: true });
    let identity;
    try { identity = validateIdentity(matchId, roundNumber); }
    catch (error) { return Promise.reject(error); }
    return this._enqueue(serverKey, () => this._stop(serverKey, identity));
  }

  async _stop(serverKey, identity) {
    this._ensureRow(serverKey, identity, "stopped");
    const existing = this._row(serverKey, identity);
    if (["ready", "already_stopped"].includes(existing?.observed_state)) {
      return { ok: true, idempotent: true, state: existing.observed_state };
    }
    this._update(serverKey, identity, { stop_requested_at: Date.now() });
    this._log("info", "stop_requested", { serverKey, ...identity });
    const command = `amx_pr_stop "${identity.matchId}" ${identity.roundNumber}`;
    const raw = await this._rconWithRetry(serverKey, command, identity, "stop");
    const response = sanitizeResponse(raw);
    const parsed = responseIdentity(response);
    this._update(serverKey, identity, { last_response: response });

    if (/\bREADY\b/i.test(response) && sameIdentity(parsed, identity)) {
      this._update(serverKey, identity, { observed_state: "ready", stopped_at: Date.now(), last_error: null });
      this._log("info", "stop_ready", { serverKey, ...identity });
      return { ok: true, state: "ready" };
    }
    if (/\bNOT_RECORDING\b/i.test(response)) {
      this._update(serverKey, identity, { observed_state: "already_stopped", stopped_at: Date.now(), last_error: null });
      this._log("info", "already_stopped", { serverKey, ...identity });
      return { ok: true, state: "already_stopped", artifactConfirmed: false };
    }
    const mismatch = /\bSTOP_REJECTED\b/i.test(response) ||
      (/\bREADY\b/i.test(response) && !sameIdentity(parsed, identity));
    const message = mismatch ? "Recorder stop identity mismatch" : `Recorder finalization failed: ${response}`;
    this._update(serverKey, identity, { observed_state: mismatch ? "conflict" : "finalize_failed", last_error: message });
    this._log("error", mismatch ? "stop_identity_mismatch" : "finalization_failed", { serverKey, ...identity, response });
    throw new Error(message);
  }

  reconcile(serverKey) {
    if (!this.enabled) return Promise.resolve({ ok: true, disabled: true });
    return this._enqueue(serverKey, async () => {
      const row = this.db.prepare(`SELECT * FROM pickup_replay_recordings
        WHERE server_key=? ORDER BY updated_at DESC LIMIT 1`).get(serverKey);
      if (!row) return { ok: true, state: "untracked" };
      const identity = { matchId: row.match_id, roundNumber: row.round_number };
      let raw;
      try { raw = await this.runRconCommand(serverKey, "amx_pr_status", 1); }
      catch (error) {
        const message = sanitizeResponse(error?.message || error);
        this._update(serverKey, identity, { last_error: message });
        this._log("error", "reconciliation_failed", { serverKey, ...identity, error: message });
        throw error;
      }
      const status = parseStatus(raw);
      if (status.state === "recording" && !sameIdentity(status, identity)) {
        this._update(serverKey, identity, { observed_state: "conflict", last_response: status.raw, last_error: "Recorder active identity conflict during reconciliation" });
        this._log("error", "reconciliation_conflict", { serverKey, ...identity, activeMatchId: status.matchId, activeRoundNumber: status.roundNumber });
        return { ok: false, conflict: true, ...status };
      }
      if (status.state === "recording" && row.desired_state === "stopped") {
        this._update(serverKey, identity, { observed_state: "recording", last_response: status.raw, last_error: null });
        this._log("info", "reconciliation_stop_required", { serverKey, ...identity });
        const stopped = await this._stop(serverKey, identity);
        return { ok: true, reconciledAction: "stop", ...stopped };
      }
      const observed = status.state === "idle" && row.desired_state === "stopped"
        ? "already_stopped"
        : status.state;
      this._update(serverKey, identity, { observed_state: observed, last_response: status.raw, last_error: null });
      this._log("info", "reconciled", { serverKey, ...identity, observedState: observed, desiredState: row.desired_state });
      return { ok: status.state !== "unknown", ...status };
    });
  }

  async reconcileAll() {
    if (!this.enabled) return [];
    const servers = this.db.prepare("SELECT DISTINCT server_key FROM pickup_replay_recordings").all();
    return Promise.allSettled(servers.map(({ server_key: serverKey }) => this.reconcile(serverKey)));
  }
}

module.exports = {
  PickupReplayRecorder,
  enabledFromEnv,
  parseStatus,
  sanitizeResponse,
  validateIdentity,
};
