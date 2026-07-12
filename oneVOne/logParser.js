"use strict";

const STEAM_ID = /^STEAM_[0-5]:[01]:\d+$/i;

function parseKeyValues(text) {
  const values = {};
  for (const token of String(text).trim().split(/\s+/)) {
    const at = token.indexOf("=");
    if (at > 0) values[token.slice(0, at)] = token.slice(at + 1);
  }
  return values;
}

function parseOneVOneLogLine(raw) {
  const text = String(raw || "").replace(/^[^\x20-\x7E]*/g, "").trim();
  const match = text.match(/\[TFCBOT\]\s+(1V1_[A-Z_]+)\s+(.*)$/);
  if (!match) return null;
  const eventName = match[1];
  const fields = parseKeyValues(match[2]);
  const simpleTypes = {
    "1V1_PLAYER_JOIN": "one_v_one_player_join", "1V1_PLAYER_RECONNECT": "one_v_one_player_reconnect",
    "1V1_PLAYER_READY": "one_v_one_player_ready", "1V1_PLAYER_DISCONNECT": "one_v_one_player_disconnect",
    "1V1_MATCH_START": "one_v_one_match_start", "1V1_ROUND_END": "one_v_one_round_end",
  };
  if (eventName !== "1V1_MATCH_END") {
    const type = simpleTypes[eventName];
    if (!type) return null;
    if (!fields.server) return { type: "one_v_one_invalid", reason: "missing_server", raw: text };
    if (fields.steamid && !STEAM_ID.test(fields.steamid)) return { type: "one_v_one_invalid", reason: "invalid_steamid", raw: text };
    return { type, ...fields, raw: text };
  }
  const required = ["server", "map", "winner", "loser", "winner_score", "loser_score", "duration", "kill_goal", "rounds_won", "rounds_required"];
  if (required.some(key => fields[key] == null)) return { type: "one_v_one_invalid", reason: "missing_fields", raw: text };
  if (!STEAM_ID.test(fields.winner) || !STEAM_ID.test(fields.loser) || fields.winner.toUpperCase() === fields.loser.toUpperCase()) {
    return { type: "one_v_one_invalid", reason: "invalid_players", raw: text };
  }
  const numeric = {};
  for (const key of ["winner_score", "loser_score", "duration", "kill_goal", "rounds_won", "rounds_required"]) {
    numeric[key] = Number(fields[key]);
    if (!Number.isInteger(numeric[key]) || numeric[key] < 0) return { type: "one_v_one_invalid", reason: `invalid_${key}`, raw: text };
  }
  return { type: "one_v_one_match_end", ...fields, ...numeric, raw: text };
}

module.exports = { parseOneVOneLogLine };
