"use strict";

const csvEscape = (s) => {
  if (s == null) return "";
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

function isoFrom(ts) {
  if (!ts && ts !== 0) return new Date().toISOString();
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  return new Date(ts).toISOString();
}

module.exports = { csvEscape, isoFrom };
