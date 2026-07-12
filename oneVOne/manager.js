"use strict";

const { randomUUID } = require("crypto");

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

    const id = randomUUID();
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
    challenge.timer = setTimeout(() => this.cancel(id, "expired"), this.config.challengeTtlMs);
    challenge.timer.unref?.();
    this.store?.saveChallenge(challenge);
    return { ok: true, challenge };
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

  async activate(challenge, server) {
    const resolved = this.resolveServer(server);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    server = { ...server, key: resolved.key };
    if (this.config.dryRun) {
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
    if (!result.ok) return result;
    try {
      this.store?.createReservedDuel(challenge, server, this.config);
    } catch (error) {
      this.reservations.release(server.ip, challenge.id);
      return { ok: false, reason: "persistence_failed", error };
    }
    this.pending.delete(challenge.id);
    this.pendingByPlayer.delete(challenge.challengerId);
    this.pendingByPlayer.delete(challenge.challengedId);
    this.activeByPlayer.set(challenge.challengerId, challenge.id);
    this.activeByPlayer.set(challenge.challengedId, challenge.id);
    const setup = await this.serverController.setup(result.reservation);
    if (!setup.ok) {
      this.complete(server.ip, result.reservation);
      return { ok: false, reason: "setup_failed", setup };
    }
    return { ...result, setup };
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

  complete(serverIp, reservation) {
    for (const playerId of reservation.playerDiscordIds || []) {
      if (this.activeByPlayer.get(String(playerId)) === reservation.id) this.activeByPlayer.delete(String(playerId));
    }
    return this.reservations.release(serverIp, reservation.id);
  }
}

module.exports = { DuelManager };
