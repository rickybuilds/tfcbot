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

function currentMapFor(state, serverIp) {
  return ensureCurrentMaps(state).get(normalizeIp(serverIp)) || null;
}

function recordMapEvent(state, evt) {
  const fromIp = normalizeIp(evt?.from);
  const currentMap = normalizeMap(evt?.name);

  if (!fromIp || !currentMap) return null;

  ensureCurrentMaps(state).set(fromIp, currentMap);

  const rs = state.restartRequest;
  if (!rs || rs.used || normalizeIp(rs.serverIp) !== fromIp) return null;

  const armedMap = normalizeMap(rs.map);
  const reason =
    armedMap && currentMap === armedMap
      ? "map_already_loaded"
      : "manual_map_change";

  rs.used = true;
  rs.disarmedReason = reason;

  return { reason, armedMap, currentMap, fromIp };
}

function disarmIfAlreadyOnRequestedMap(state, rs) {
  const currentMap = currentMapFor(state, rs?.serverIp);
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
