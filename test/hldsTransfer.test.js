"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTransfer(files) {
  const downloaded = new Map();
  class SFTP {
    async connect() {}
    async list() { return files; }
    async fastGet(remote, local) {
      downloaded.set(local, `Loading map "${files.find(f => f.name === path.basename(remote)).map}"`);
    }
    async end() {}
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/hldsTransfer.js"), "utf8"), {
    module, process, console,
    require: name => name === "ssh2-sftp-client" ? SFTP
      : name === "../lib/ensureDir" ? dir => dir
      : name === "fs" ? { readFileSync: file => downloaded.get(file), unlinkSync: file => downloaded.delete(file) }
      : require(name),
  });
  return module.exports;
}

const now = Math.floor(Date.now() / 1000);
const files = [
  { name: "L001.log", map: "ass_dm", size: 100 * 1024, modifyTime: now - 60 },
  { name: "L003.log", map: "other", size: 100 * 1024, modifyTime: now },
  { name: "L002.log", map: "ass_dm", size: 100 * 1024, modifyTime: now - 10 },
];

test("single-log duels select only the latest matching map after consecutive matches", async () => {
  const result = await loadTransfer(files).downloadLogs({ map: "ass_dm", maxLogs: 1 });
  assert.deepEqual(Array.from(result.localPaths, p => path.basename(p)), ["L002.log"]);
});

test("single-log duels accept small logs without selecting an older match", async () => {
  const result = await loadTransfer(files.map(f => ({ ...f, size: 1024 }))).downloadLogs({ map: "ass_dm", maxLogs: 1 });
  assert.deepEqual(Array.from(result.localPaths, p => path.basename(p)), ["L002.log"]);
});

test("pickups retain two matching logs by default", async () => {
  const result = await loadTransfer(files).downloadLogs({ map: "ass_dm" });
  assert.deepEqual(Array.from(result.localPaths, p => path.basename(p)), ["L001.log", "L002.log"]);
});
