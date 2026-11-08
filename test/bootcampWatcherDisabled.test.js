"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startBootcampWatcher, stopBootcampWatcher } = require("../services/bootcampWatcher");

test("the watcher does not access storage or Discord unless explicitly enabled", async () => {
  const before = process.env.BOOTCAMP_WATCHER_ENABLED;
  delete process.env.BOOTCAMP_WATCHER_ENABLED;
  let apiCalls = 0;
  try {
    await startBootcampWatcher({ client: {}, api: { latestEventId: async () => { apiCalls++; return 0; } },
      steamLinks: {}, logger: { info() {}, warn() {} } });
    assert.equal(apiCalls, 0);
  } finally {
    stopBootcampWatcher();
    if (before === undefined) delete process.env.BOOTCAMP_WATCHER_ENABLED;
    else process.env.BOOTCAMP_WATCHER_ENABLED = before;
  }
});
