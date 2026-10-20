"use strict";
const STEAM = /^STEAM_[0-5]:[01]:\d+$/i;
const normalizeSteamId = value => STEAM.test(String(value || "")) ? String(value).toUpperCase() : null;

function parseStatus(raw) {
  const text = String(raw || "");
  const mapName = text.match(/^map\s*:\s*(\S+)/im)?.[1];
  const count = text.match(/^players\s*:\s*(\d+)\s+active/im)?.[1];
  const footer = text.match(/^\s*(\d+)\s+users?\s*$/im)?.[1];
  const rows = text.split(/\r?\n/).filter(l => /^\s*#\s*\d+\s+"/.test(l));
  if (!mapName || count == null || footer == null || rows.length !== Number(count) || Number(footer) !== rows.length) {
    throw new Error("Incomplete server status roster");
  }
  const steamIds = [];
  for (const row of rows) {
    const match = row.match(/^\s*#\s*\d+\s+".*"\s+\d+\s+(\S+)/);
    if (!match) throw new Error("Incomplete server status player");
    const id = normalizeSteamId(match[1]);
    if (id) steamIds.push(id);
  }
  return { mapName, steamIds: [...new Set(steamIds)], complete: true };
}

function rosterPresence(rosterIds, links, present) {
  const owners = new Map();
  for (const id of rosterIds) for (const raw of links[id] || []) {
    const steam = normalizeSteamId(raw);
    if (!steam) continue;
    if (!owners.has(steam)) owners.set(steam, new Set());
    owners.get(steam).add(id);
  }
  const here = rosterIds.filter(id => (links[id] || []).some(raw => {
    const steam = normalizeSteamId(raw);
    return owners.get(steam)?.size === 1 && present.has(steam);
  }));
  return { here, allPresent: rosterIds.length === 8 && new Set(rosterIds).size === 8 && here.length === 8 };
}

class PresenceTracker {
  constructor() { this.servers = new Map(); }
  state(key) {
    if (!this.servers.has(key)) this.servers.set(key, { version: 0, sessions: new Map(), mapName: null });
    return this.servers.get(key);
  }
  beginQuery(key) { return ++this.state(key).version; }
  get(key) { return new Set(this.state(key).sessions.keys()); }
  reconcile(key, token, roster) {
    const s = this.state(key);
    if (token !== s.version) return false;
    s.sessions = new Map(roster.steamIds.map(id => [normalizeSteamId(id), null]).filter(([id]) => id));
    s.mapName = roster.mapName;
    return true;
  }
  event(evt) {
    const s = this.state(evt.serverKey);
    const steam = normalizeSteamId(evt.steamid);
    if (evt.type === "map") { s.version++; s.sessions.clear(); s.mapName = evt.name; }
    if (!steam) return;
    if (evt.type === "connect") { s.version++; s.sessions.set(steam, String(evt.userid)); }
    if (evt.type === "disconnect") {
      s.version++;
      if (s.sessions.get(steam) === String(evt.userid) || s.sessions.get(steam) === null) s.sessions.delete(steam);
    }
  }
}
module.exports = { parseStatus, rosterPresence, PresenceTracker, normalizeSteamId };
