"use strict";

function normalizeIp(value) {
  return String(value || "").trim().split(":")[0];
}

function normalizeMap(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureCurrentMaps(state) {
  if (!(state.hldsCurrentMaps instanceof Map)) {
    state.hldsCurrentMaps = new Map();
  }
  return state.hldsCurrentMaps;
}

function endpointKey(serverIp) {
  const value = String(serverIp || "").trim().toLowerCase();
  return value.includes(":") ? value : normalizeIp(value);
}

function currentMapFor(state, serverIp, serverKey = null) {
  const maps = ensureCurrentMaps(state);
  if (serverKey && maps.has(serverKey)) return maps.get(serverKey);
  return maps.get(endpointKey(serverIp)) || maps.get(normalizeIp(serverIp)) || null;
}

function recordMapEvent(state, evt) {
  const fromIp = normalizeIp(evt?.from);
  const currentMap = normalizeMap(evt?.name);
  const sourceKey = evt?.serverKey || endpointKey(
    evt?.from && evt?.sourcePort ? `${evt.from}:${evt.sourcePort}` : evt?.from
  );

  if (!fromIp || !currentMap || !sourceKey) return null;

  ensureCurrentMaps(state).set(sourceKey, currentMap);

  const rs = state.restartRequest;
  if (!rs || rs.used) return null;
  if (rs.serverKey && evt.serverKey) {
    if (rs.serverKey !== evt.serverKey) return null;
  } else if (normalizeIp(rs.serverIp) !== fromIp) {
    return null;
  }

  const armedMap = normalizeMap(rs.map);
  const reason =
    armedMap && currentMap === armedMap
      ? "map_already_loaded"
      : "manual_map_change";

  rs.used = true;
  rs.disarmedReason = reason;

  return { reason, armedMap, currentMap, fromIp, serverKey: evt.serverKey || null };
}

function disarmIfAlreadyOnRequestedMap(state, rs) {
  const currentMap = currentMapFor(state, rs?.serverIp, rs?.serverKey);
  const requestedMap = normalizeMap(rs?.map);

  if (!currentMap || !requestedMap || currentMap !== requestedMap) {
    return null;
  }

  rs.used = true;
  rs.disarmedReason = "map_already_loaded";
  return currentMap;
}

module.exports = {
  currentMapFor,
  disarmIfAlreadyOnRequestedMap,
  normalizeIp,
  normalizeMap,
  recordMapEvent,
};
