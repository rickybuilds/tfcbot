// services/hldsLogs.js
"use strict";
const dgram = require("dgram");
const servers = require("../config/rcon");
const net = require("net");
let currentLogFile = null;
/* -------------------------------------------------------------------------- */
/* Match ID handoff */
/* -------------------------------------------------------------------------- */
let pendingMatchId = null;
function setCurrentMatchId(matchId) {
  pendingMatchId = matchId;
  console.log(`[hldsLogs] Pending matchId set: ${matchId}`);
  // NEW: If map was armed already, start recording now.
  for (const [ip, vs] of perSourceVoice.entries()) {
    if (vs.armed && !vs.recording) {
      const finalId = takeMatchId();
      console.log(`[hldsLogs] matchId arrived late → starting voice recording for ${finalId}`);
      startVoiceRecording(finalId);
      vs.recording = true;
    }
  }
}
// Peek without consuming
function peekMatchId() {
  return pendingMatchId;
}
// Only consume when we REALLY start recording
function takeMatchId() {
  const id = pendingMatchId || `unknown_${Date.now()}`;
  pendingMatchId = null;
  return id;
}
/* -------------------------------------------------------------------------- */
/* NEW: Simple forwarding to spectator bot via local TCP control */
/* -------------------------------------------------------------------------- */
const CONTROL_PORT = Number(process.env.VOICE_CONTROL_PORT || 6200);
let controlSocket = null;
let controlQueue = [];
// ensure we have a socket, flush queued messages once connected
function ensureControlSocket() {
  if (controlSocket && !controlSocket.destroyed) return;
  controlSocket = net.createConnection(
    { host: "127.0.0.1", port: CONTROL_PORT },
    () => {
      console.log("[hldsLogs] Connected to spectator control port");
      // flush any queued messages
      for (const msg of controlQueue) {
        controlSocket.write(msg);
      }
      controlQueue = [];
    }
  );
  controlSocket.on("error", err => {
    console.warn("[hldsLogs] Spectator control error:", err.message);
    if (!controlSocket.destroyed) controlSocket.destroy();
    controlSocket = null;
  });
  controlSocket.on("close", () => {
    console.log("[hldsLogs] Spectator control connection closed");
    controlSocket = null;
  });
}
function sendControlMessage(obj) {
  const line = JSON.stringify(obj) + "\n";
  ensureControlSocket();
  if (controlSocket && !controlSocket.destroyed && controlSocket.writable) {
    controlSocket.write(line);
  } else {
    // queue until we connect
    controlQueue.push(line);
  }
}
function startVoiceRecording(matchId = "unknown") {
  console.log(`[hldsLogs] Request → START voice recording for ${matchId}`);
  sendControlMessage({ type: "start", matchId });
}
function stopVoiceRecording() {
  console.log("[hldsLogs] Request → STOP voice recording");
  sendControlMessage({ type: "stop" });
}
/* -------------------------------------------------------------------------- */
/* Log Parser — unchanged (still perfect) */
/* -------------------------------------------------------------------------- */
function parseLine(raw) {
  let s = String(raw).trim();
  s = s.replace(/^[^\x20-\x7E]*/g, "");
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
  return null;
}
/* -------------------------------------------------------------------------- */
/* UDP Listener + Score Pairing */
/* -------------------------------------------------------------------------- */
const perSourceVoice = new Map();
function getVoiceState(ip) {
  let s = perSourceVoice.get(ip);
  if (!s) {
    s = { armed: false, recording: false };
    perSourceVoice.set(ip, s);
  }
  return s;
}
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
    const parsed = parseLine(msg);
    if (!parsed) return;
    const evt = { ...parsed, from, ts: Date.now() };
    // ---------- MAP EVENT → START RECORDING (FIXED) ----------
    if (evt.type === "map") {
      const vs = getVoiceState(from);
      vs.armed = true;
      const matchId = peekMatchId();
      if (matchId) {
        // ONLY NOW do we actually consume it
        const finalId = takeMatchId();
        console.log(`[hldsLogs] Starting voice recording for ${finalId}`);
        startVoiceRecording(finalId);
        vs.recording = true;
      } else {
        console.log(`[hldsLogs] Armed but no matchId yet — will start recording as soon as matchId arrives`);
        // No 5s grace timer anymore — we wait indefinitely until matchId is set
        // This is safe because AutoRecap ALWAYS sets it before the real match
      }
      onEvent?.(evt);
      return;
    }
    // ---------- FINAL SCORE → STOP RECORDING ----------
    if (evt.type === "score_pair") {
      onEvent?.(evt);
      const vs = getVoiceState(from);
      if (vs.recording) {
        console.log("[hldsLogs] Final score detected → stopping voice recording");
        stopVoiceRecording();
        vs.recording = false;
      }
      return;
    }
    // ---------- LOG CLOSED → CLEANUP ----------
    if (evt.type === "log_closed") {
      const vs = getVoiceState(from);
      if (vs.recording) stopVoiceRecording();
      vs.recording = false;
      vs.armed = false;
      onEvent?.(evt);
      return;
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
  setCurrentMatchId,
  startVoiceRecording,
  stopVoiceRecording,
};