"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startBootcampWatcher, stopBootcampWatcher } = require("../services/bootcampWatcher");

test("the watcher does not access storage or Discord unless explicitly enabled", async () => {
  const before = process.env.BOOTCAMP_WATCHER_ENABLED;
  delete process.env.BOOTCAMP_WATCHER_ENABLED;
  let calls = 0;
  try {
    await startBootcampWatcher({ client: {}, pool: { query: async () => { calls++; return [[]]; } }, logger: { info() {}, warn() {} } });
    assert.equal(calls, 0);
  } finally {
    stopBootcampWatcher();
    if (before === undefined) delete process.env.BOOTCAMP_WATCHER_ENABLED;
    else process.env.BOOTCAMP_WATCHER_ENABLED = before;
  }
});
