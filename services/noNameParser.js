"use strict";

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
const { importNoNameStats } = require("../lib/noNameStatsImport");

function parserBaseUrl() { return process.env.NONAME_PARSER_URL?.trim() || "http://127.0.0.1:3210"; }
function isConfigured() { return true; }
function matchPageUrl(matchId) {
  const template = process.env.NONAME_PARSER_MATCH_URL || "https://nonamepickup.servehalflife.com/match.html?id={matchId}";
  return new URL(template.replaceAll("{matchId}", encodeURIComponent(String(matchId)))).href;
}
function isOwnParserUrl(url) {
  if (!isConfigured() || !url) return false;
  try {
    const candidate = new URL(url);
    const website = new URL(matchPageUrl("match-id"));
    return candidate.origin === new URL(parserBaseUrl()).origin || (candidate.origin === website.origin && candidate.pathname === website.pathname);
  } catch { return false; }
}

async function uploadToNoNameParser({ paths = [], matchId, map, baseUrl = parserBaseUrl(), token = process.env.NONAME_PARSER_TOKEN, timeoutMs = 120000, maxResponseBytes = 32 * 1024 * 1024, importStats = importNoNameStats, db, dbPath, extra = {} }) {
  const streams = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  try {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(matchId || ""))) throw new Error("Invalid match ID");
    if (!paths.length || paths.length > 2) throw new Error("One or two log files required");
    const base = new URL(String(baseUrl).replace(/\/+$/, "") + "/");
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("Parser URL must use HTTP or HTTPS");
    const form = new FormData();
    form.append("matchId", String(matchId));
    if (map) form.append("map", String(map));
    if (extra.force === "on") form.append("force", "on");
    for (const file of [...paths].sort()) {
      if (!fs.statSync(file).isFile()) throw new Error("Log file required");
      const stream = fs.createReadStream(file); streams.push(stream);
      form.append("logs[]", stream, { filename: path.basename(file), contentType: "text/plain" });
    }
    const headers = form.getHeaders();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(new URL("api/parseGame", base).href, { method: "POST", body: form, headers, signal: controller.signal, size: maxResponseBytes, redirect: "error" });
    status = res.status;
    const raw = await res.text();
    if (!res.ok) return { ok: false, status, text: raw.slice(0, 1000), parser: "noname", url: null };
    const payload = JSON.parse(raw);
    if (!payload.success?.path || payload.result?.matchId !== String(matchId) || payload.result?.schemaVersion !== 1) throw new Error("Invalid parser result or match ID");
    const url = new URL(payload.success.path, base).href;
    if (new URL(url).origin !== base.origin && url !== matchPageUrl(matchId)) throw new Error("Parser returned an unexpected result URL");
    const apiUrl = payload.success.api ? new URL(payload.success.api, base).href : null;
    const imported = await importStats({ result: payload.result, matchId: String(matchId), sourceUrl: url, db, dbPath });
    return { ok: true, status, text: "Structured parser result imported", url, apiUrl, parser: "noname", imported, result: payload.result };
  } catch (error) {
    return { ok: false, status, text: error.message, parser: "noname", url: null };
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const stream of streams) stream.destroy();
  }
}

module.exports = { isConfigured, isOwnParserUrl, parserBaseUrl, matchPageUrl, uploadToNoNameParser };
