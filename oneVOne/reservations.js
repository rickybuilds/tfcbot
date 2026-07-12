"use strict";

class ServerReservations {
  constructor(state) {
    this.state = state;
    if (!state.serverReservations) state.serverReservations = new Map();
    if (!state.lockedServers) state.lockedServers = new Set();
  }

  get(serverIp) {
    return this.state.serverReservations.get(String(serverIp)) || null;
  }

  isAvailable(serverIp) {
    const ip = String(serverIp || "");
    return !!ip && !this.state.serverReservations.has(ip) && !this.state.lockedServers.has(ip);
  }

  available(servers) {
    return (servers || []).filter(server => this.isAvailable(server.ip));
  }

  reserve(serverIp, reservation) {
    const ip = String(serverIp || "");
    if (!this.isAvailable(ip)) return { ok: false, current: this.get(ip) };
    const record = Object.freeze({
      ...reservation,
      serverIp: ip,
      locked: true,
      reservedAt: reservation.reservedAt || Date.now(),
    });
    this.state.serverReservations.set(ip, record);
    this.state.lockedServers.add(ip);
    return { ok: true, reservation: record };
  }

  release(serverIp, expectedId = null) {
    const ip = String(serverIp || "");
    const current = this.get(ip);
    if (current && expectedId != null && String(current.id) !== String(expectedId)) {
      return { ok: false, reason: "reservation_mismatch", current };
    }
    if (current) this.state.serverReservations.delete(ip);
    this.state.lockedServers.delete(ip);
    return { ok: !!current, reservation: current };
  }
}

module.exports = { ServerReservations };
