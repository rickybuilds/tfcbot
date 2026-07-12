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
  const marker = "[TFCBOT] 1V1_MATCH_END ";
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const fields = parseKeyValues(text.slice(at + marker.length));
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
