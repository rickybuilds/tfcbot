#!/usr/bin/env node
"use strict";

const BASE = process.env.API_BASE || "http://127.0.0.1:4000";
const PLAYER_ID = process.env.PLAYER_ID || "255834576742645761";
const PLAYER_ID_2 = process.env.PLAYER_ID_2 || "176878275262545920";
const MATCH_ID = process.env.MATCH_ID || "4Q6CV2";
const MAP = encodeURIComponent(process.env.MAP || "2fort");
const SEARCH = encodeURIComponent(process.env.SEARCH || "ric");
const SLOW_MS = Number(process.env.SLOW_MS || 1000);

const endpoints = [
  "/api/health",
  "/api/supporters",
  "/api/leaderboard?limit=50&days=30",
  "/api/matches?limit=25&offset=0&includePending=1",
  `/api/match/${MATCH_ID}`,
  `/api/players/search?q=${SEARCH}&limit=20`,
  `/api/steam/profile/${PLAYER_ID}`,
  `/api/player/${PLAYER_ID}/v3`,
  `/api/player/${PLAYER_ID}/recent?limit=50`,
  `/api/player/${PLAYER_ID}/permap`,
  `/api/player/${PLAYER_ID}/granular?limit=50`,
  `/api/player/${PLAYER_ID}/granular?limit=50&includeSample=1`,
  `/api/player/${PLAYER_ID}/granular/events?limit=100&offset=0`,
  "/api/topplayers?days=30",
  `/api/map/${MAP}/players`,
  `/api/map/${MAP}/matches`,
  "/api/mapaverages",
  "/api/stats/mvps",
  "/api/stats/matchOutcomes",
  "/api/stats/summary",
  "/api/stats/players",
  "/api/stats/streaks",
  "/api/analytics?limit=5",
  "/api/home",
  "/api/queue",
  `/api/compare?p1=${PLAYER_ID}&p2=${PLAYER_ID_2}`,
  `/api/vegasodds/${PLAYER_ID}`,
];

async function testEndpoint(path) {
  const url = `${BASE}${path}`;
  const start = performance.now();

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    const ms = performance.now() - start;

    let jsonOk = true;
    let okField = null;

    try {
      const json = JSON.parse(text);
      okField = json.ok;
    } catch {
      jsonOk = false;
    }

    const pass = res.ok && jsonOk && okField !== false;

    return {
      pass,
      status: res.status,
      ms,
      bytes: Buffer.byteLength(text),
      path,
      error: pass ? "" : `bad response jsonOk=${jsonOk} ok=${okField}`,
    };
  } catch (err) {
    return {
      pass: false,
      status: 0,
      ms: performance.now() - start,
      bytes: 0,
      path,
      error: err.message,
    };
  }
}

(async () => {
  console.log(`Testing API: ${BASE}`);
  console.log(`PLAYER_ID=${PLAYER_ID}`);
  console.log(`PLAYER_ID_2=${PLAYER_ID_2}`);
  console.log(`MATCH_ID=${MATCH_ID}`);
  console.log(`MAP=${decodeURIComponent(MAP)}`);
  console.log("");

  const results = [];

  for (const endpoint of endpoints) {
    const result = await testEndpoint(endpoint);
    results.push(result);

    const icon = result.pass ? "✅" : "❌";
    const ms = result.ms.toFixed(1).padStart(7);
    const status = String(result.status).padStart(3);
    const kb = (result.bytes / 1024).toFixed(1).padStart(7);
    const slowMark = result.ms > SLOW_MS ? " 🐢" : "";

    console.log(`${icon} ${status} ${ms}ms ${kb} KB  ${result.path}${slowMark}`);
    if (!result.pass) console.log(`   ${result.error}`);
  }

  const failed = results.filter(r => !r.pass);
  const slow = results.filter(r => r.ms > SLOW_MS);
  const sorted = [...results].sort((a, b) => b.ms - a.ms);

  console.log("");
  console.log(`Passed: ${results.length - failed.length}/${results.length}`);
  console.log(`Slow >${SLOW_MS}ms: ${slow.length}`);

  console.log("");
  console.log("Top 10 Slowest Endpoints");
  console.log("------------------------");
  for (const r of sorted.slice(0, 10)) {
    console.log(`${r.ms.toFixed(1).padStart(8)}ms  ${r.path}`);
  }

  if (failed.length) {
    console.log("");
    console.log("Failed endpoints:");
    for (const r of failed) {
      console.log(`- ${r.status} ${r.path} ${r.error}`);
    }
  }

  process.exit(failed.length ? 1 : 0);
})();
