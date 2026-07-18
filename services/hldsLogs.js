// services/hldsLogs.js
"use strict";
const dgram = require("dgram");
const servers = require("../config/rcon");
const { parseOneVOneLogLine } = require("../oneVOne/logParser");
/* -------------------------------------------------------------------------- */
/* Log Parser — unchanged (still perfect) */
/* -------------------------------------------------------------------------- */
function parseLine(raw, currentLogFile = null) {
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
      if (!global._teamFileTrack[currentLogFile]) global._teamFileTrack[currentLogFile] = 0;
      let order = ++global._teamFileTrack[currentLogFile];
      if (order > 2) order = global._teamFileTrack[currentLogFile] = 1;
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

return null;
}
/* -------------------------------------------------------------------------- */
/* UDP Listener + Score Pairing */
/* -------------------------------------------------------------------------- */
const currentLogFileBySource = new Map();
function startHldsLogReceiver(client, opts = {}, onEvent) {
  if (process.env.NO_HLDS_LISTENER === "1") {
    return { close: () => {} };
  }
  const sock = dgram.createSocket("udp4");
  const allowedIPs = [...new Set(Object.values(servers).map(s => s.host?.split(":")[0]).filter(Boolean))];
  const lastScoresBySource = new Map();
  sock.on("message", (msg, rinfo) => {
    const from = rinfo.address;
    global.lastHldsPacketAt = Date.now();
    if (allowedIPs.length && !allowedIPs.includes(from)) return;
    const parsed = parseLine(msg, currentLogFileBySource.get(from) || null);
    if (!parsed) return;
    if (parsed.type === "logfile") currentLogFileBySource.set(from, parsed.file);
    if (parsed.type === "log_closed") currentLogFileBySource.delete(from);
    const evt = { ...parsed, from, ts: Date.now() };
    if (evt.type === "say") {
      const text = String(evt.text || "").trim().toLowerCase();

      if (text === "!rs") {
        console.log(
          `[!rs] request player=${evt.player} steamid=${evt.steamid} team=${evt.team} from=${from}`
        );

        onEvent?.({
          type: "restart_request",
          from,
          steamid: evt.steamid,
          player: evt.player,
          team: evt.team,
          ts: evt.ts,
          raw: evt.raw
        });

        return;
      }
    }
    // ---------- SCORE PAIRING LOGIC (unchanged) ----------
  let last = lastScoresBySource.get(from) || { map: null, blue: null, red: null, ts: 0 };
    if (evt.type === "map") {
      last = { map: evt.name, blue: null, red: null, ts: evt.ts };
      lastScoresBySource.set(from, last);
    }
    if (evt.type === "score") {
      if (evt.ts - last.ts > 9000) {
        last = { map: last.map, blue: null, red: null, ts: evt.ts };
      }
      if (/blue/i.test(evt.team)) last.blue = evt.score;
      if (/red/i.test(evt.team)) last.red = evt.score;
      last.ts = evt.ts;
      lastScoresBySource.set(from, last);
      if (last.blue != null && last.red != null) {
        const pair = {
          type: "score_pair",
          map: last.map || "unknown",
          blue: last.blue,
          red: last.red,
          ts: evt.ts,
          from
        };
        onEvent?.(pair);
        lastScoresBySource.delete(from);
        return;
      }
    }
    onEvent?.(evt);
  });
  sock.bind(27500, "0.0.0.0", () => console.log("[HLDS] listening on UDP 27500"));
  return { close: () => sock.close() };
}
/* -------------------------------------------------------------------------- */
/* Export */
/* -------------------------------------------------------------------------- */
module.exports = {
  startHldsLogReceiver,
};
