"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PresenceTracker } = require("../predictions/presence");

const steamid = "STEAM_0:1:1";
const event = overrides => ({ serverKey: "east", logInstance: "current.log", sourceTime: "10/22/2026 - 12:00:02", ...overrides });

function currentMap() {
  const presence = new PresenceTracker();
  presence.event(event({ type: "map", name: "shutdown2" }));
  return presence;
}

test("presence explicitly rejects a live marker older than the current source time", () => {
  const presence = currentMap();
  assert.equal(presence.event(event({ type: "prediction_live_start", sourceTime: "10/22/2026 - 12:00:01" })), false);
  assert.equal(presence.state("east").mapName, "shutdown2");
});

test("presence accepts a current live marker without a player identity", () => {
  const presence = currentMap();
  assert.equal(presence.event(event({ type: "prediction_live_start" })), true);
});

test("presence rejects live markers from an obsolete logfile", () => {
  const presence = currentMap();
  assert.equal(presence.event(event({ type: "prediction_live_start", logInstance: "old.log" })), false);
});

test("a rejected old map leaves the current roster and in-flight query valid", () => {
  const presence = currentMap();
  presence.event(event({ type: "connect", steamid, userid: "11" }));
  const token = presence.beginQuery("east");
  assert.equal(presence.event(event({ type: "map", name: "lobby", sourceTime: "10/22/2026 - 12:00:01" })), false);
  assert.equal(presence.state("east").mapName, "shutdown2");
  assert.deepEqual([...presence.get("east")], [steamid]);
  assert.equal(presence.reconcile("east", token, { mapName: "shutdown2", steamIds: [steamid] }), true);
});

test("an accepted map clears the roster and invalidates an earlier status query", () => {
  const presence = currentMap();
  presence.event(event({ type: "connect", steamid, userid: "11" }));
  const token = presence.beginQuery("east");
  assert.equal(presence.event(event({ type: "map", name: "openfire" })), true);
  assert.equal(presence.state("east").mapName, "openfire");
  assert.equal(presence.get("east").size, 0);
  assert.equal(presence.reconcile("east", token, { mapName: "shutdown2", steamIds: [steamid] }), false);
});

for (const type of ["connect", "disconnect"]) {
  test(`presence explicitly rejects an obsolete ${type} userid`, () => {
    const presence = currentMap();
    presence.event(event({ type: "connect", steamid, userid: "11" }));
    assert.equal(presence.event(event({ type, steamid, userid: "10" })), false);
    assert.deepEqual([...presence.get("east")], [steamid]);
  });
}

test("a disconnected session cannot reconnect from a duplicate delayed event", () => {
  const presence = currentMap();
  presence.event(event({ type: "connect", steamid, userid: "11" }));
  presence.event(event({ type: "disconnect", steamid, userid: "11" }));
  assert.equal(presence.event(event({ type: "connect", steamid, userid: "11" })), false);
  assert.equal(presence.get("east").size, 0);
});

test("accepted logfile and repeated connect events retain their existing behavior", () => {
  const presence = currentMap();
  assert.equal(presence.event(event({ type: "logfile", file: "next.log" })), true);
  assert.equal(presence.state("east").logInstance, "next.log");
  const connect = event({ type: "connect", steamid, userid: "11", logInstance: "next.log" });
  assert.equal(presence.event(connect), true);
  assert.equal(presence.event(connect), true);
  assert.deepEqual([...presence.get("east")], [steamid]);
});
