"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { recordMapEvent, reserveRestartRequest } = require("../lib/restartRequestPolicy");
const request = () => ({ serverIp: "192.0.2.210:27015", serverKey: "pickup", map: "castra_b6", used: false });
function load(state, now, serverKey = "pickup") {
  recordMapEvent(state, { from: "192.0.2.210", serverKey, name: "castra_b6" }, now);
}
test("map load renews restart availability but overlapping requests are blocked", () => {
  const state = { restartRequest: request() };
  assert.equal(reserveRestartRequest(state, state.restartRequest, 0), null);
  assert.equal(reserveRestartRequest(state, state.restartRequest, 1), "already_used");
  load(state, 1000);
  assert.equal(reserveRestartRequest(state, state.restartRequest, 180999), null);
  assert.equal(reserveRestartRequest(state, state.restartRequest, 180999), "already_used");
});
test("three-minute boundary expires and another map load renews it", () => {
  const state = { restartRequest: request() };
  load(state, 1000);
  assert.equal(reserveRestartRequest(state, state.restartRequest, 181000), "window_expired");
  load(state, 200000);
  assert.equal(reserveRestartRequest(state, state.restartRequest, 200001), null);
});
test("pre-arm map loads retain their original time and other servers cannot renew it", () => {
  const state = {};
  load(state, 1000);
  state.restartRequest = request();
  load(state, 200000, "pickupSkill");
  assert.equal(reserveRestartRequest(state, state.restartRequest, 200001), "window_expired");
});
