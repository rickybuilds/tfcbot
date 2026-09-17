"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function manager(fail = () => false) {
  const calls = [];
  const pm2 = Object.fromEntries(["connect", "start", "stop"].map(method => [method, (...args) => {
    const callback = args.pop();
    calls.push([method, ...args]);
    setImmediate(() => callback(fail(method, ...args) ? new Error("PM2 failure") : null));
  }]));
  pm2.disconnect = () => calls.push(["disconnect"]);
  const context = { module: { exports: {} }, require: () => pm2, console: { log() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/voiceManager.js"), "utf8"), context);
  return { ...context.module.exports, calls };
}

test("start then stop requests serialize and disconnect PM2", async () => {
  const voice = manager();
  await Promise.all([voice.startVoiceBots(), voice.stopVoiceBots()]);
  assert.deepEqual(voice.calls, [
    ["connect"], ["start", "tfcbot-spectator"], ["start", "tfcbot-blue"], ["start", "tfcbot-red"], ["disconnect"],
    ["connect"], ["stop", "tfcbot-blue"], ["stop", "tfcbot-red"], ["stop", "tfcbot-spectator"], ["disconnect"],
  ]);
});

test("failed start cleans up all roles and later requests can still run", async () => {
  const voice = manager((method, name) => method === "start" && name === "tfcbot-red");
  await assert.rejects(voice.startVoiceBots(), /PM2 failure/);
  assert.equal(voice.calls.filter(([method]) => method === "stop").length, 3);
  assert.deepEqual(voice.calls.at(-1), ["disconnect"]);
  await voice.stopVoiceBots();
});

test("failed team stop still stops spectator and disconnects", async () => {
  const voice = manager((method, name) => method === "stop" && name === "tfcbot-blue");
  await assert.rejects(voice.stopVoiceBots(), /Could not stop all voice bots/);
  assert.ok(voice.calls.some(([method, name]) => method === "stop" && name === "tfcbot-spectator"));
  assert.deepEqual(voice.calls.at(-1), ["disconnect"]);
});
