"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currentMapFor,
  disarmIfAlreadyOnRequestedMap,
  recordMapEvent,
} = require("../lib/restartRequestPolicy");

test("loading the requested map disarms !rs", () => {
  const state = {
    restartRequest: {
      serverIp: "108.61.128.120:27015",
      map: "castra_b6",
      used: false,
    },
  };

  const result = recordMapEvent(state, {
    type: "map",
    from: "108.61.128.120",
    name: "CASTRA_B6",
  });

  assert.equal(result.reason, "map_already_loaded");
  assert.equal(state.restartRequest.used, true);
  assert.equal(state.restartRequest.disarmedReason, "map_already_loaded");
  assert.equal(currentMapFor(state, "108.61.128.120:27015"), "castra_b6");
});

test("loading a different map disarms !rs as a manual map change", () => {
  const state = {
    restartRequest: {
      serverIp: "108.61.128.120:27015",
      map: "castra_b6",
      used: false,
    },
  };

  const result = recordMapEvent(state, {
    type: "map",
    from: "108.61.128.120",
    name: "shutdown2",
  });

  assert.equal(result.reason, "manual_map_change");
  assert.equal(state.restartRequest.used, true);
});

test("a map observed before !rs was armed still blocks restarting that map", () => {
  const state = {};
  recordMapEvent(state, {
    type: "map",
    from: "108.61.128.120",
    name: "castra_b6",
  });

  const rs = {
    serverIp: "108.61.128.120:27015",
    map: "castra_b6",
    used: false,
  };

  const currentMap = disarmIfAlreadyOnRequestedMap(state, rs);

  assert.equal(currentMap, "castra_b6");
  assert.equal(rs.used, true);
  assert.equal(rs.disarmedReason, "map_already_loaded");
});

test("!rs remains available when the server is on a different map", () => {
  const state = {};
  recordMapEvent(state, {
    type: "map",
    from: "108.61.128.120",
    name: "shutdown2",
  });

  const rs = {
    serverIp: "108.61.128.120:27015",
    map: "castra_b6",
    used: false,
  };

  assert.equal(disarmIfAlreadyOnRequestedMap(state, rs), null);
  assert.equal(rs.used, false);
});

test("same-host SKILLS map events cannot consume a pickup restart request", () => {
  const state = {
    restartRequest: {
      serverIp: "192.0.2.210:27015",
      serverKey: "pickup",
      map: "blutopia_tfp",
      used: false,
    },
  };

  const result = recordMapEvent(state, {
    type: "map",
    from: "192.0.2.210",
    sourcePort: 27016,
    serverKey: "pickupSkill",
    name: "raiden9",
  });

  assert.equal(result, null);
  assert.equal(state.restartRequest.used, false);
  assert.equal(currentMapFor(state, "192.0.2.210:27015", "pickup"), null);
  assert.equal(currentMapFor(state, "192.0.2.210:27016", "pickupSkill"), "raiden9");
});
