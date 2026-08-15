// services/hldsLogs.js
"use strict";
const dgram = require("dgram");
const servers = require("../config/rcon");
const { parseOneVOneLogLine } = require("../oneVOne/logParser");
const { PlayerIdentityStore } = require("../lib/playerIdentityStore");

const STEAM_ID_RE = /^STEAM_[0-5]:[01]:\d+$/i;

function normalizeSteamId(value) {
  const steamId = String(value || "").trim();
  return STEAM_ID_RE.test(steamId) ? steamId.toUpperCase() : null;
}

function addressToIp(address) {
  const value = String(address || "").trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return value.replace(/:\d+$/, "");
}

function serverNameForSource(source, sourcePort = null) {
  const matchedKey = serverKeyForSource(source, sourcePort);
  if (matchedKey && servers[matchedKey]) {
    return servers[matchedKey].name || matchedKey;
  }

  const sourceIp = addressToIp(source);
  for (const [key, server] of Object.entries(servers)) {
    if (addressToIp(server.host) === sourceIp) return server.name || key;
  }
  return sourceIp;
}

function serverKeyForSource(source, sourcePort = null) {
  const sourceIp = addressToIp(source);
  const matches = Object.entries(servers)
    .filter(([, server]) => addressToIp(server.host) === sourceIp);

  if (matches.length === 1) return matches[0][0];
  if (matches.length === 0) return null;

  const exact = matches.find(([, server]) => {
    const expectedPort = Number(server.logSourcePort || server.port);
    return Number(sourcePort) === expectedPort;
  });
  return exact?.[0] || null;
}

function sourceKeyForSource(source, sourcePort = null) {
  const serverKey = serverKeyForSource(source, sourcePort);
  if (serverKey) return serverKey;
  const ip = addressToIp(source);
  return `${ip}:${Number(sourcePort) || "?"}`;
}

function isPickupServerKey(serverKey) {
  return Boolean(serverKey && servers[serverKey] && !servers[serverKey].trackingOnly);
}

function isTrackingOnlyServerKey(serverKey) {
  return Boolean(serverKey && servers[serverKey]?.trackingOnly);
}
/* -------------------------------------------------------------------------- */
/* Log Parser */
/* -------------------------------------------------------------------------- */
function parseLine(raw, currentLogFile = null, trackingKey = null) {
  let s = String(raw).trim();
  s = s.replace(/^[^\x20-\x7E]*/g, "");
  const oneVOneEvent = parseOneVOneLogLine(s);
  if (oneVOneEvent) return oneVOneEvent;
  const mFile = s.match(/Log file started \(file "([^"]+)"\)/i);
  if (mFile) {
    currentLogFile = mFile[1];
    return { type: "logfile", file: currentLogFile, raw: s };
  }
  const mMap = s.match(/Started\s+map\s+"([^"]+)"/i);
  if (mMap) return { type: "map", name: mMap[1], raw: s };
  if (/Log file closed/i.test(s)) return { type: "log_closed", raw: s };
  if (/\[HLTV\]/i.test(s)) {
    if (/Starting record/i.test(s)) return { type: "hltv_start", raw: s };
    if (/Stopped/i.test(s)) return { type: "hltv_stop", raw: s };
  }
  let mScore = s.match(/Team\s+"([^"]+)"\s+scored\s+"(-?\d+)"/i);
  if (!mScore) {
    const mCustom = s.match(/Team\s+(\d+)\s+scored\s+"(-?\d+)"/i);
    if (mCustom) {
      const team = Number(mCustom[1]) === 1 ? "Blue" : "Red";
      return { type: "score", team, score: Number(mCustom[2]), raw: s };
    }
  }
  if (mScore) {
    const teamRaw = mScore[1];
    const team = /blue/i.test(teamRaw) ? "Blue" : /red/i.test(teamRaw) ? "Red" : null;
    if (!team) {
      if (!global._teamFileTrack) global._teamFileTrack = {};
      const teamTrackKey = `${trackingKey || "default"}:${currentLogFile || "unknown"}`;
      if (!global._teamFileTrack[teamTrackKey]) global._teamFileTrack[teamTrackKey] = 0;
      let order = ++global._teamFileTrack[teamTrackKey];
      if (order > 2) order = global._teamFileTrack[teamTrackKey] = 1;
      return { type: "score", team: order === 1 ? "Blue" : "Red", score: Number(mScore[2]), raw: s, halfOrder: order };
    }
    return { type: "score", team, score: Number(mScore[2]), raw: s };
  }
/* -------------------------------------------------------------------------- */
/* Added this on 5/27/26 */
/* -------------------------------------------------------------------------- */
  const mCap = s.match(/"([^"]+)<(\d+)><([^>]+)><(Red|Blue)>" triggered "([^"]+)"/i);

  if (mCap) {
    return {
      type: "capture",
      player: mCap[1],
      team: mCap[4],
      trigger: mCap[5],
      raw: s
    };
  }
/* -------------------------------------------------------------------------- */
/* until here*/
/* -------------------------------------------------------------------------- */
  const mSay = s.match(/"([^"]+)<(\d+)><([^>]+)><([^>]*)>" say "([^"]+)"/i);

  if (mSay) {
    return {
      type: "say",
      player: mSay[1],
      userid: mSay[2],
      steamid: mSay[3],
      team: mSay[4],
      text: mSay[5],
      raw: s
    };
  }

  const mConnect = s.match(/"([^"]+)<(\d+)><([^>]+)><([^>]*)>" connected, address "([^"]+)"/i);

  if (mConnect) {
    return {
      type: "connect",
      player: mConnect[1],
      userid: mConnect[2],
      steamid: mConnect[3],
      team: mConnect[4],
      ip: addressToIp(mConnect[5]),
      raw: s
    };
  }

  const mDisconnect = s.match(/"([^"]+)<(\d+)><([^>]+)><([^>]*)>" disconnected/i);

  if (mDisconnect) {
    return {
      type: "disconnect",
      player: mDisconnect[1],
      userid: mDisconnect[2],
      steamid: mDisconnect[3],
      team: mDisconnect[4],
      raw: s
    };
  }

  const mKill = s.match(/"([^"]+)<(\d+)><([^>]+)><([^>]*)>" killed "([^"]+)<(\d+)><([^>]+)><([^>]*)>" with "([^"]+)"/i);

  if (mKill) {
    return {
      type: "kill",
      killer: mKill[1],
      killerUserid: mKill[2],
      killerSteamid: mKill[3],
      killerTeam: mKill[4],
      victim: mKill[5],
      victimUserid: mKill[6],
      victimSteamid: mKill[7],
      victimTeam: mKill[8],
      weapon: mKill[9],
      raw: s
    };
  }

return null;
}
/* -------------------------------------------------------------------------- */
/* UDP Listener + Score Pairing */
/* -------------------------------------------------------------------------- */
const currentLogFileBySource = new Map();

function updateScorePair(lastScoresBySource, evt) {
  const sourceKey = evt.sourceKey || sourceKeyForSource(evt.from, evt.sourcePort);
  let last = lastScoresBySource.get(sourceKey) || { map: null, blue: null, red: null, ts: 0 };

  if (evt.type === "map") {
    last = { map: evt.name, blue: null, red: null, ts: evt.ts };
    lastScoresBySource.set(sourceKey, last);
    return null;
  }

  if (evt.type !== "score") return null;
  if (evt.ts - last.ts > 9000) {
    last = { map: last.map, blue: null, red: null, ts: evt.ts };
  }
  if (/blue/i.test(evt.team)) last.blue = evt.score;
  if (/red/i.test(evt.team)) last.red = evt.score;
  last.ts = evt.ts;
  lastScoresBySource.set(sourceKey, last);

  if (last.blue == null || last.red == null) return null;
  const pair = {
    type: "score_pair",
    map: last.map || "unknown",
    blue: last.blue,
    red: last.red,
    ts: evt.ts,
    from: evt.from,
    sourcePort: evt.sourcePort,
    serverKey: evt.serverKey,
    sourceKey,
    trackingOnly: evt.trackingOnly,
  };
  lastScoresBySource.delete(sourceKey);
  return pair;
}

function startHldsLogReceiver(client, opts = {}, onEvent) {
  if (process.env.NO_HLDS_LISTENER === "1") {
    return { close: () => {} };
  }
  let identityStore = opts.identityStore || null;
  let ownsIdentityStore = false;
  if (!identityStore) {
    try {
      identityStore = new PlayerIdentityStore(opts.identityDbPath);
      ownsIdentityStore = true;
    } catch (err) {
      console.error("[HLDS identity] failed to initialize:", err);
    }
  }
  const sock = dgram.createSocket("udp4");
  const configuredIPs = Object.values(servers)
    .map(s => addressToIp(s.host))
    .filter(Boolean);
  const requestedIPs = Array.isArray(opts.allowedSources)
    ? opts.allowedSources.map(addressToIp).filter(Boolean)
    : [];
  const allowedIPs = [...new Set([...configuredIPs, ...requestedIPs])];
  const lastScoresBySource = new Map();
  sock.on("message", (msg, rinfo) => {
    const from = rinfo.address;
    global.lastHldsPacketAt = Date.now();
    if (allowedIPs.length && !allowedIPs.includes(from)) return;
    const records = String(msg).split(/\r?\n/).filter(record => record.trim());
    for (const record of records) {
      const sourceKey = sourceKeyForSource(from, rinfo.port);
      const serverKey = serverKeyForSource(from, rinfo.port);
      const currentLogFile = currentLogFileBySource.get(sourceKey) || null;
      const parsed = parseLine(record, currentLogFile, sourceKey);
      if (!parsed) continue;
      if (parsed.type === "logfile") currentLogFileBySource.set(sourceKey, parsed.file);
      if (parsed.type === "log_closed") {
        currentLogFileBySource.delete(sourceKey);
        if (currentLogFile && global._teamFileTrack) {
          delete global._teamFileTrack[`${sourceKey}:${currentLogFile}`];
        }
      }
      const evt = {
        ...parsed,
        from,
        sourcePort: rinfo.port,
        serverKey,
        sourceKey,
        trackingOnly: isTrackingOnlyServerKey(serverKey),
        ts: Date.now(),
      };
      const steamId = normalizeSteamId(evt.steamid);
      if (identityStore && steamId && evt.type === "connect") {
        try {
          identityStore.recordConnect({
            steamId,
            alias: evt.player,
            ip: evt.ip,
            server: serverNameForSource(from, rinfo.port),
            timestamp: evt.ts,
          });
        } catch (err) {
          console.error(`[HLDS identity] connect write failed for ${steamId}:`, err);
        }
      }
      if (identityStore && steamId && evt.type === "disconnect") {
        try {
          identityStore.recordDisconnect(steamId, evt.ts);
        } catch (err) {
          console.error(`[HLDS identity] disconnect write failed for ${steamId}:`, err);
        }
      }
      if (evt.type === "say" && String(evt.text || "").trim().toLowerCase() === "!rs") {
        onEvent?.({
          type: "restart_request",
          from,
          sourcePort: evt.sourcePort,
          serverKey: evt.serverKey,
          sourceKey: evt.sourceKey,
          trackingOnly: evt.trackingOnly,
          steamid: evt.steamid,
          player: evt.player,
          team: evt.team,
          ts: evt.ts,
          raw: evt.raw
        });
        continue;
      }
      const pair = updateScorePair(lastScoresBySource, evt);
      if (pair) {
        onEvent?.(pair);
        continue;
      }
      onEvent?.(evt);
    }
  });
  const listenPort = Number(opts.port || 27500);
  sock.bind(listenPort, "0.0.0.0", () => {
    console.log(`[HLDS] listening on UDP ${listenPort}`);
  });
  return {
    close: () => {
      sock.close();
      if (ownsIdentityStore) identityStore?.close();
    }
  };
}
/* -------------------------------------------------------------------------- */
/* Export */
/* -------------------------------------------------------------------------- */
module.exports = {
  parseLine,
  serverKeyForSource,
  sourceKeyForSource,
  updateScorePair,
  isPickupServerKey,
  isTrackingOnlyServerKey,
  startHldsLogReceiver,
};
