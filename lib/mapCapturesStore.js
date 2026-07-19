"use strict";
const fs = require("fs");
const path = require("path");
const FILE = path.resolve(process.cwd(), "mapCaptures.json");

function loadMapCaptures({ onError } = {}) {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (error) {
    onError?.(error);
    return {};
  }
}

function saveMapCaptures(data) { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }

module.exports = { loadMapCaptures, saveMapCaptures };
