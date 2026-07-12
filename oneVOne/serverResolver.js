"use strict";

function endpoint(host, port) {
  const raw = String(host || "").trim();
  const match = raw.match(/^(.+?):(\d+)$/);
  return { host: (match ? match[1] : raw).toLowerCase(), port: Number(match ? match[2] : port) || 27015 };
}

function resolveServerKey(server, rconServers) {
  const selected = endpoint(server?.ip);
  if (!selected.host) return { ok: false, reason: "missing_server_ip" };
  const matches = Object.entries(rconServers || {}).filter(([, cfg]) => {
    const configured = endpoint(cfg.host, cfg.port);
    return configured.host === selected.host && configured.port === selected.port;
  });
  if (matches.length !== 1) return { ok: false, reason: matches.length ? "ambiguous_mapping" : "mapping_not_found", selected };
  return { ok: true, key: matches[0][0], config: matches[0][1], selected };
}

module.exports = { resolveServerKey };
