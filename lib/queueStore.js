// lib/queueStore.js
"use strict";
const fs = require("fs");
const path = require("path");

class QueueStore {
  constructor(file = "queue.json") {
    this.file = path.resolve(file);
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
  save(queueArr, onError) {
    try {
      const out = JSON.stringify(Array.isArray(queueArr) ? queueArr : [], null, 2);
      fs.writeFileSync(this.file, out, "utf8");
    } catch (e) {
      onError?.(e);
    }
  }
}
module.exports = { QueueStore };
