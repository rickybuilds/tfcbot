// lib/jailStore.js
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.resolve(process.cwd(), "jails.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

class JailStore {
  constructor() {
    this.data = load();
  }

  set(userId, info) {
    this.data[userId] = info;
    save(this.data);
  }

  get(userId) {
    return this.data[userId] || null;
  }

  delete(userId) {
    delete this.data[userId];
    save(this.data);
  }

  all() {
    return this.data;
  }
}

module.exports = { JailStore };
