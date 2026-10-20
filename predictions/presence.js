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
  const steamIds = [], sessions=[];
  for (const row of rows) {
    const match = row.match(/^\s*#\s*\d+\s+".*"\s+(\d+)\s+(\S+)/);
    if (!match) throw new Error("Incomplete server status player");
    const id = normalizeSteamId(match[2]);
    if (id) {steamIds.push(id);sessions.push({steamId:id,userid:match[1]});}
  }
  return { mapName, steamIds: [...new Set(steamIds)], sessions, complete: true };
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
    if (!this.servers.has(key)) this.servers.set(key, { version: 0, sessions: new Map(), lastIds:new Map(), departed:new Set(), sourceOrder:null, logInstance:null, mapName: null });
    return this.servers.get(key);
  }
  beginQuery(key) { return ++this.state(key).version; }
  get(key) { return new Set(this.state(key).sessions.keys()); }
  reconcile(key, token, roster) {
    const s = this.state(key);
    if (token !== s.version) return false;
    const supplied=new Map((roster.sessions||[]).map(r=>[normalizeSteamId(r.steamId),String(r.userid)]));
    const next=new Map(roster.steamIds.map(raw=>{const id=normalizeSteamId(raw);return [id,supplied.get(id)||s.sessions.get(id)||null];}).filter(([id])=>id));
    for(const [id,session] of s.sessions)if(!next.has(id)&&session!=null)s.departed.add(`${id}:${session}`);
    for(const [id,session] of next)if(session!=null){s.lastIds.set(id,session);s.departed.delete(`${id}:${session}`);}
    s.sessions=next;
    s.mapName = roster.mapName;
    return true;
  }
  event(evt) {
    const s = this.state(evt.serverKey);
    const stamp=String(evt.sourceTime||"").match(/^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}:\d{2}:\d{2})$/);
    const order=stamp?`${stamp[3]}${stamp[1]}${stamp[2]}${stamp[4]}`:null;
    if(order&&s.sourceOrder&&order<s.sourceOrder)return;
    if(order)s.sourceOrder=order;
    if(evt.type==="logfile")s.logInstance=evt.file;
    if(evt.logInstance&&s.logInstance&&evt.logInstance!==s.logInstance&&evt.type!=="logfile")return;
    const steam = normalizeSteamId(evt.steamid);
    if (evt.type === "map") { s.version++; s.sessions.clear();s.lastIds.clear();s.departed.clear(); s.mapName = evt.name;if(evt.logInstance)s.logInstance=evt.logInstance; }
    if (!steam) return;
    const session=String(evt.userid),previous=s.lastIds.get(steam);
    if(previous!=null&&/^\d+$/.test(previous)&&/^\d+$/.test(session)&&BigInt(session)<BigInt(previous))return;
    if (evt.type === "connect") {
      if(s.departed.has(`${steam}:${session}`))return;
      s.version++;s.lastIds.set(steam,session);s.sessions.set(steam,session);
    }
    if (evt.type === "disconnect") {
      s.version++;s.lastIds.set(steam,session);s.departed.add(`${steam}:${session}`);
      if (s.sessions.get(steam) === session || s.sessions.get(steam) === null) s.sessions.delete(steam);
    }
  }
}
module.exports = { parseStatus, rosterPresence, PresenceTracker, normalizeSteamId };
