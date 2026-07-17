"use strict";

const fs = require("fs");
const path = require("path");

function appendKickedPlayers(
  userIds,
  message,
  file = path.join(process.cwd(), "kicked.json")
) {
  const ids = [...new Set((userIds || []).map(String))];
  if (!ids.length) return null;

  const names = ids.map(id => {
    const member = message?.guild?.members?.cache?.get(id);
    return member?.displayName || `<@${id}>`;
  }).join(", ");

  let entries = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
  }

  const entry = {
    timestamp: new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
    }),
    reason: "missed_server_vote",
    names,
    ids,
  };

  entries.push(entry);
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return entry;
}

module.exports = { appendKickedPlayers };
