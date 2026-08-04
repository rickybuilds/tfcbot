"use strict";

const { genMatchId } = require("../lib/util");

class DuelManager {
  constructor({ config, state, steamLinks, reservations, store = null, resolveServer, serverController }) {
    this.config = config;
    this.state = state;
    this.steamLinks = steamLinks;
    this.reservations = reservations;
    this.store = store;
    this.resolveServer = resolveServer;
    this.serverController = serverController;
    this.pending = new Map();
    this.pendingByPlayer = new Map();
    this.activeByPlayer = new Map();
    this.completing = new Set();
    this.timers = new Map();
    this.statusHandlers = new Map();
  }

  isPickupLocked(discordId) {
    return this.state.lockedPlayers?.has(String(discordId)) || false;
  }

  isBusy(discordId) {
    const id = String(discordId);
    return this.pendingByPlayer.has(id) || this.activeByPlayer.has(id) || this.isPickupLocked(id);
  }

  createChallenge(challenger, challenged) {
    const p1 = String(challenger.id);
    const p2 = String(challenged.id);
    if (p1 === p2) return { ok: false, reason: "self" };
    if (challenged.bot) return { ok: false, reason: "bot" };
    if (this.isBusy(p1)) return { ok: false, reason: "challenger_busy" };
    if (this.isBusy(p2)) return { ok: false, reason: "challenged_busy" };

    let id = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = genMatchId();
      if (!this.pending.has(candidate) && !this.store?.idExists(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) return { ok: false, reason: "id_generation_failed" };
    const challenge = {
      id,
      challengerId: p1,
      challengedId: p2,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.challengeTtlMs,
      status: "pending",
    };
    this.pending.set(id, challenge);
    this.pendingByPlayer.set(p1, id);
    this.pendingByPlayer.set(p2, id);
    challenge.timer = setTimeout(() => {
      const expired = this.cancel(id, "expired");
      if (expired?.onExpire) Promise.resolve(expired.onExpire(expired)).catch(() => {});
    }, this.config.challengeTtlMs);
    challenge.timer.unref?.();
    this.store?.saveChallenge(challenge);
    return { ok: true, challenge };
  }

  onChallengeExpire(id, handler) {
    const challenge = this.pending.get(String(id));
    if (!challenge || typeof handler !== "function") return false;
    challenge.onExpire = handler;
    return true;
  }

  incomingFor(discordId) {
    const challenge = this.pending.get(this.pendingByPlayer.get(String(discordId)));
    return challenge?.challengedId === String(discordId) ? challenge : null;
  }

  cancel(id, reason) {
    const challenge = this.pending.get(String(id));
    if (!challenge) return null;
    clearTimeout(challenge.timer);
    challenge.status = reason;
    this.pending.delete(challenge.id);
    this.pendingByPlayer.delete(challenge.challengerId);
    this.pendingByPlayer.delete(challenge.challengedId);
    this.store?.finishChallenge(challenge.id, reason, reason);
    return challenge;
  }

  async primarySteamId(discordId) {
    const rows = await this.steamLinks.getSteamIds(String(discordId));
    const primary = rows.filter(row => Number(row.is_primary) === 1);
    if (primary.length === 1) return { ok: true, steamId: primary[0].steam_id };
    if (rows.length === 1) return { ok: true, steamId: rows[0].steam_id };
    return { ok: false, reason: rows.length ? "ambiguous" : "missing" };
  }

  async accept(discordId) {
    const challenge = this.incomingFor(discordId);
    if (!challenge) return { ok: false, reason: "not_found" };
    if (challenge.expiresAt <= Date.now()) {
      this.cancel(challenge.id, "expired");
      return { ok: false, reason: "expired" };
    }
    if (this.isPickupLocked(challenge.challengerId) || this.isPickupLocked(challenge.challengedId)) {
      return { ok: false, reason: "pickup_locked" };
    }
    const [p1, p2] = await Promise.all([
      this.primarySteamId(challenge.challengerId),
      this.primarySteamId(challenge.challengedId),
    ]);
    if (!p1.ok || !p2.ok) return { ok: false, reason: "steam_link", players: { p1, p2 } };
    const available = this.reservations.available(this.state.servers);
    if (!available.length) return { ok: false, reason: "no_servers" };
    clearTimeout(challenge.timer);
    challenge.status = "accepted";
    challenge.player1SteamId = p1.steamId;
    challenge.player2SteamId = p2.steamId;
    this.store?.finishChallenge(challenge.id, "accepted");
    return { ok: true, challenge, availableServers: available };
  }

  async activate(challenge, server, { onStatus } = {}) {
    console.log(`[1v1] - activation requested id=${challenge.id} server=${server?.name || server?.ip || "unknown"}`);
    if (typeof onStatus === "function") this.statusHandlers.set(String(challenge.id), onStatus);
    const resolved = this.resolveServer(server);
    if (!resolved.ok) {
      console.warn(`[1v1] - activation rejected id=${challenge.id} reason=${resolved.reason}`);
      this.statusHandlers.delete(String(challenge.id));
      return { ok: false, reason: resolved.reason };
    }
    server = { ...server, key: resolved.key };
    if (this.config.dryRun) {
      console.log(`[1v1] - dry-run activation completed id=${challenge.id} server=${resolved.key}`);
      this.statusHandlers.delete(String(challenge.id));
      this.pending.delete(challenge.id);
      this.pendingByPlayer.delete(challenge.challengerId);
      this.pendingByPlayer.delete(challenge.challengedId);
      return {
        ok: true,
        simulated: true,
        reservation: { id: challenge.id, mode: "1v1", serverIp: server.ip, status: "dry_run" },
      };
    }
    const result = this.reservations.reserve(server.ip, {
      id: challenge.id,
      mode: "1v1",
      serverKey: server.key || null,
      playerDiscordIds: [challenge.challengerId, challenge.challengedId],
      playerSteamIds: [challenge.player1SteamId, challenge.player2SteamId],
      status: "reserved",
    });
    if (!result.ok) {
      console.warn(`[1v1] - reservation failed id=${challenge.id} server=${server.key} reason=${result.reason || "unavailable"}`);
      this.statusHandlers.delete(String(challenge.id));
      return result;
    }
    console.log(`[1v1] - server reserved id=${challenge.id} server=${server.key} ip=${server.ip}`);
    try {
      this.store?.createReservedDuel(challenge, server, this.config);
    } catch (error) {
      console.error(`[1v1] - reservation persistence failed id=${challenge.id} server=${server.key}`, error);
      this.reservations.release(server.ip, challenge.id);
      this.statusHandlers.delete(String(challenge.id));
      return { ok: false, reason: "persistence_failed", error };
    }
    this.pending.delete(challenge.id);
    this.pendingByPlayer.delete(challenge.challengerId);
    this.pendingByPlayer.delete(challenge.challengedId);
    this.activeByPlayer.set(challenge.challengerId, challenge.id);
    this.activeByPlayer.set(challenge.challengedId, challenge.id);
    const setup = await this.serverController.beginSetup(result.reservation);
    if (!setup.ok) {
      console.error(`[1v1] - map change command failed id=${challenge.id} server=${server.key} command=${setup.failedCommand || "unknown"}`, setup.error);
      this.store?.updateStatus(challenge.id, "cancelled", {
        cancelled_at: Date.now(),
        cancellation_reason: "setup_failed",
      });
      this.complete(server.ip, result.reservation);
      return { ok: false, reason: "setup_failed", setup };
    }
    console.log(`[1v1] - map change command sent id=${challenge.id} server=${server.key} map=${this.config.map}`);
    this.setTimer(challenge.id, "setup", this.config.setupTimeoutMs, () => this.cancelActive(challenge.id, "setup_timeout"));
    return { ...result, setup, waitingForMap: true };
  }

  status() {
    return { pending: [...this.pending.values()], reservations: [...(this.state.serverReservations || new Map()).values()] };
  }

  restorePending() {
    if (!this.store) return 0;
    let restored = 0;
    for (const challenge of this.store.pendingChallenges()) {
      if (this.pendingByPlayer.has(challenge.challengerId) || this.pendingByPlayer.has(challenge.challengedId)) continue;
      const remaining = Math.max(1, challenge.expiresAt - Date.now());
      challenge.timer = setTimeout(() => this.cancel(challenge.id, "expired"), remaining);
      challenge.timer.unref?.();
      this.pending.set(challenge.id, challenge);
      this.pendingByPlayer.set(challenge.challengerId, challenge.id);
      this.pendingByPlayer.set(challenge.challengedId, challenge.id);
      restored++;
    }
    return restored;
  }

  findReservationForEvent(evt) {
    const from = String(evt.from || "").split(":")[0];
    for (const [serverIp, reservation] of this.state.serverReservations || []) {
      if (String(serverIp).split(":")[0] !== from || reservation.mode !== "1v1") continue;
      const expected = new Set((reservation.playerSteamIds || []).map(value => String(value).toUpperCase()));
      if (expected.size !== 2 || !expected.has(String(evt.winner).toUpperCase()) || !expected.has(String(evt.loser).toUpperCase())) {
        return { ok: false, reason: "steam_mismatch", reservation };
      }
      return { ok: true, serverIp, reservation };
    }
    return { ok: false, reason: "reservation_not_found" };
  }

  recordLogFile(evt) {
    const from = String(evt.from || "").split(":")[0];
    for (const [serverIp, reservation] of this.state.serverReservations || []) {
      if (reservation.mode !== "1v1" || String(serverIp).split(":")[0] !== from) continue;
      const files = new Set(reservation.logFiles || []);
      files.add(evt.file);
      const updated = Object.freeze({ ...reservation, logFiles: [...files] });
      this.state.serverReservations.set(serverIp, updated);
      return true;
    }
    return false;
  }

  reservationFromSource(from) {
    const ip = String(from || "").split(":")[0];
    return [...(this.state.serverReservations || [])].find(([serverIp, value]) => value.mode === "1v1" && String(serverIp).split(":")[0] === ip) || null;
  }

  async handleMap(evt) {
    if (String(evt.name).toLowerCase() !== String(this.config.map).toLowerCase()) return false;
    const entry = this.reservationFromSource(evt.from);
    if (!entry) return false;
    const [serverIp, reservation] = entry;
    console.log(`[1v1] - expected map observed id=${reservation.id} server=${reservation.serverKey || serverIp} map=${evt.name}`);
    this.clearTimer(reservation.id, "setup");
    // Lifecycle messages can beat the map-start message over UDP. Preserve any
    // players (or even a match start) already observed for this reservation.
    const joined = new Set(reservation.joined || []);
    const status = reservation.status === "active"
      ? "active"
      : joined.size === 2 ? "waiting_for_ready" : "waiting_for_players";
    this.updateReservation(serverIp, {
      status,
      joined: [...joined],
      ready: [...new Set(reservation.ready || [])],
    });
    if (status === "active") {
      this.clearTimer(reservation.id, "join");
      this.clearTimer(reservation.id, "ready");
    } else if (joined.size === 2) {
      this.clearTimer(reservation.id, "join");
      this.setTimer(reservation.id, "ready", this.config.readyTimeoutMs, () => this.cancelActive(reservation.id, "ready_timeout"));
    } else {
      this.setTimer(reservation.id, "join", this.config.joinTimeoutMs, () => this.cancelActive(reservation.id, "join_timeout"));
    }
    console.log(`[1v1] - map settle period started id=${reservation.id} server=${reservation.serverKey || serverIp} delay=${this.config.postMapSetupDelayMs || 0}ms`);
    const setup = await this.serverController.finishSetup(reservation);
    if (!setup.ok) {
      this.clearAllTimers(reservation.id);
      console.error(`[1v1] - post-map setup failed id=${reservation.id} server=${reservation.serverKey || serverIp} command=${setup.failedCommand || "unknown"}`, setup.error);
      const quarantined = this.reservations.quarantine(serverIp, reservation, "post_map_setup_failed");
      this.store?.updateStatus(reservation.id, "quarantined", { cancellation_reason: "post_map_setup_failed" });
      await this.notifyStatus(reservation.id, {
        type: "failed",
        reason: "post_map_setup_failed",
        reservation: quarantined,
      });
      this.statusHandlers.delete(String(reservation.id));
      return true;
    }
    const updated = this.reservations.get(serverIp);
    console.log(`[1v1] - post-map setup completed id=${reservation.id} server=${reservation.serverKey || serverIp}; status=${updated?.status || "waiting_for_players"}`);
    const notified = await this.notifyStatus(reservation.id, { type: "ready", reservation: updated });
    console.log(`[1v1] - ready notification id=${reservation.id} delivered=${notified}`);
    return true;
  }

  handleLifecycle(evt) {
    const entry = this.reservationFromSource(evt.from);
    if (!entry) return false;
    const [serverIp, reservation] = entry;
    const steam = String(evt.steamid || "").toUpperCase();
    if (steam && !(reservation.playerSteamIds || []).map(String).map(s => s.toUpperCase()).includes(steam)) return true;
    if (evt.type === "one_v_one_player_join" || evt.type === "one_v_one_player_reconnect") {
      const joined = new Set(reservation.joined || []); joined.add(steam);
      const status = reservation.status === "active" ? "active" : joined.size === 2 ? "waiting_for_ready" : "waiting_for_players";
      this.updateReservation(serverIp, { joined: [...joined], status });
      console.log(`[1v1] - player joined id=${reservation.id} server=${reservation.serverKey || serverIp} joined=${joined.size}/2`);
      if (joined.size === 2) {
        this.clearTimer(reservation.id, "join");
        if (status !== "active") this.setTimer(reservation.id, "ready", this.config.readyTimeoutMs, () => this.cancelActive(reservation.id, "ready_timeout"));
      }
      this.clearTimer(reservation.id, `disconnect:${steam}`);
    } else if (evt.type === "one_v_one_player_ready") {
      // The plugin only accepts !ready from an assigned, connected player, so a
      // ready event is also authoritative evidence that this player joined.
      const joined = new Set(reservation.joined || []); joined.add(steam);
      const ready = new Set(reservation.ready || []); ready.add(steam);
      const status = reservation.status === "active" ? "active" : "waiting_for_ready";
      this.updateReservation(serverIp, { joined: [...joined], ready: [...ready], status });
      console.log(`[1v1] - player ready id=${reservation.id} server=${reservation.serverKey || serverIp} ready=${ready.size}/2`);
      if (joined.size === 2) this.clearTimer(reservation.id, "join");
      if (status !== "active") this.setTimer(reservation.id, "ready", this.config.readyTimeoutMs, () => this.cancelActive(reservation.id, "ready_timeout"));
    } else if (evt.type === "one_v_one_player_disconnect") {
      console.warn(`[1v1] - player disconnected id=${reservation.id} server=${reservation.serverKey || serverIp}; grace timer started`);
      this.setTimer(reservation.id, `disconnect:${steam}`, this.config.disconnectGraceMs, () => this.cancelActive(reservation.id, "disconnect_timeout"));
    } else if (evt.type === "one_v_one_match_start") {
      // MATCH_START is authoritative proof that both assigned players joined and
      // readied. No pre-match timeout may remain armed once play is underway.
      this.clearTimer(reservation.id, "join");
      this.clearTimer(reservation.id, "ready");
      this.updateReservation(serverIp, { status: "active" });
      console.log(`[1v1] - match started id=${reservation.id} server=${reservation.serverKey || serverIp}`);
    }
    return true;
  }

  updateReservation(serverIp, patch) {
    const current = this.state.serverReservations.get(serverIp);
    if (!current) return null;
    const updated = Object.freeze({ ...current, ...patch }); this.state.serverReservations.set(serverIp, updated); return updated;
  }

  async notifyStatus(id, status) {
    const handler = this.statusHandlers.get(String(id));
    if (!handler) return false;
    try {
      await handler(status);
      return true;
    } catch (error) {
      console.error(`[1v1] - status notification failed id=${id} type=${status?.type || "unknown"}`, error);
      return false;
    }
  }

  setTimer(id, name, ms, fn) {
    this.clearTimer(id, name);
    const key = `${id}:${name}`;
    const timer = setTimeout(() => {
      console.warn(`[1v1] - timer expired id=${id} timer=${name}`);
      Promise.resolve().then(fn).catch(error => {
        console.error(`[1v1] - timer action failed id=${id} timer=${name}`, error);
      });
    }, ms);
    timer.unref?.();
    this.timers.set(key, timer);
  }
  clearTimer(id, name) { const key = `${id}:${name}`; const timer = this.timers.get(key); if (timer) clearTimeout(timer); this.timers.delete(key); }
  clearAllTimers(id) { for (const [key, timer] of this.timers) if (key.startsWith(`${id}:`)) { clearTimeout(timer); this.timers.delete(key); } }

  beginCompletion(id) {
    if (this.completing.has(String(id))) return false;
    this.completing.add(String(id));
    return true;
  }

  endCompletion(id) { this.completing.delete(String(id)); }

  recoverActive() {
    if (!this.store) return 0;
    let count = 0;
    for (const row of this.store.activeDuels()) {
      if (!row.server_ip || this.state.serverReservations.has(row.server_ip)) continue;
      const reservation = {
        id: row.match_id, mode: "1v1", serverKey: row.server_key, serverIp: row.server_ip,
        playerDiscordIds: [row.challenger_discord_id, row.challenged_discord_id],
        playerSteamIds: [row.player1_steam_id, row.player2_steam_id], status: row.status,
        locked: true, reservedAt: row.reserved_at,
      };
      this.state.serverReservations.set(row.server_ip, Object.freeze(reservation));
      this.state.lockedServers.add(row.server_ip);
      this.activeByPlayer.set(row.challenger_discord_id, row.match_id);
      this.activeByPlayer.set(row.challenged_discord_id, row.match_id);
      count++;
    }
    return count;
  }

  async cancelActive(id, reason) {
    const entry = [...(this.state.serverReservations || [])].find(([, value]) => value.mode === "1v1" && String(value.id) === String(id));
    if (!entry) return { ok: false, reason: "not_found" };
    const [serverIp, reservation] = entry;
    console.warn(`[1v1] - cancelling active duel id=${id} server=${reservation.serverKey || serverIp} reason=${reason}`);
    const restored = await this.serverController.restore(reservation);
    if (!restored.ok) {
      console.error(`[1v1] - server restore failed id=${id} server=${reservation.serverKey || serverIp} command=${restored.failedCommand || "unknown"}`, restored.error);
      const quarantined = this.reservations.quarantine(serverIp, reservation, "restore_failed");
      this.store?.updateStatus(id, "quarantined", { cancellation_reason: reason });
      await this.notifyStatus(id, { type: "failed", reason: "restore_failed", cancellationReason: reason, reservation: quarantined });
      this.statusHandlers.delete(String(id));
      return { ok: false, reason: "restore_failed", restored };
    }
    this.store?.updateStatus(id, "cancelled", { cancelled_at: Date.now(), cancellation_reason: reason });
    await this.notifyStatus(id, { type: "cancelled", reason, reservation });
    this.complete(serverIp, reservation);
    console.log(`[1v1] - active duel cancelled and server released id=${id} server=${reservation.serverKey || serverIp} reason=${reason}`);
    return { ok: true, restored };
  }

  complete(serverIp, reservation) {
    this.clearAllTimers(reservation.id);
    this.statusHandlers.delete(String(reservation.id));
    for (const playerId of reservation.playerDiscordIds || []) {
      if (this.activeByPlayer.get(String(playerId)) === reservation.id) this.activeByPlayer.delete(String(playerId));
    }
    return this.reservations.release(serverIp, reservation.id);
  }

  async restoreAndComplete(serverIp, reservation) {
    const restored = await this.serverController.restore(reservation);
    if (!restored.ok) {
      this.reservations.quarantine(serverIp, reservation, "restore_failed_after_match");
      this.store?.updateStatus(reservation.id, "quarantined", { cancellation_reason: "restore_failed_after_match" });
      return { ok: false, quarantined: true, restored };
    }
    return { ok: true, restored, released: this.complete(serverIp, reservation) };
  }
}

module.exports = { DuelManager };
