"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  findCleanFirstPickupCap,
  parseEventsCsv,
  postCleanFirstPickupClips,
} = require("../services/pickupReplayClips");

function event(timeMs, name, actorSession, entity = 0, text = "blue") {
  return { timeMs, event: name, actorSession, entity, text };
}

test("clean clip detection finds the first pickup carried back to base", () => {
  const clip = findCleanFirstPickupCap([
    event(0, "flag_entity_base", 0, 42),
    event(12000, "flag_pickup", 7, 0, "blue"),
    event(12100, "flag_entity_carried", 7, 42),
    event(18000, "team_score", 0),
    event(18100, "flag_release", 7),
    event(18400, "flag_entity_base", 0, 42),
  ]);

  assert.equal(clip.actorSession, 7);
  assert.equal(clip.entity, 42);
  assert.equal(clip.pickupTime, 12);
  assert.equal(clip.capTime, 18);
  assert.equal(clip.clipStart, 9);
  assert.equal(clip.clipEnd, 21.4);
});

test("a drop in the first pickup sequence prevents automatic posting", () => {
  const clip = findCleanFirstPickupCap([
    event(0, "flag_entity_base", 0, 42),
    event(12000, "flag_pickup", 7),
    event(12100, "flag_entity_carried", 7, 42),
    event(15000, "flag_entity_dropped", 0, 42),
    event(18400, "flag_entity_base", 0, 42),
  ]);
  assert.equal(clip, null);
});

test("a recovery pickup after a drop is not coast-to-coast", () => {
  const clip = findCleanFirstPickupCap([
    event(0, "flag_entity_base", 0, 42),
    event(12000, "flag_pickup", 7),
    event(12100, "flag_entity_carried", 7, 42),
    event(15000, "flag_entity_dropped", 0, 42),
    event(16000, "flag_pickup", 8),
    event(16100, "flag_entity_carried", 8, 42),
    event(18000, "team_score", 0),
    event(18100, "flag_release", 8),
    event(18400, "flag_entity_base", 0, 42),
  ]);
  assert.equal(clip, null);
});

test("events CSV parser preserves quoted flag labels", () => {
  const events = parseEventsCsv([
    "time_ms,event,actor_session,target_session,entity,value1,value2,int_value1,int_value2,text",
    '12000,flag_pickup,7,0,0,0,0,0,1,"blue flag"',
  ].join("\n"));
  assert.deepEqual(events[0], {
    timeMs: 12000,
    event: "flag_pickup",
    actorSession: 7,
    entity: 0,
    text: "blue flag",
  });
});

test("automatic clip posting is idempotent per replay round", async () => {
  const db = new Database(":memory:");
  const sent = [];
  const client = {
    channels: {
      fetch: async () => ({ send: async payload => sent.push(payload) }),
    },
  };
  const csv = [
    "time_ms,event,actor_session,target_session,entity,value1,value2,int_value1,int_value2,text",
    "0,flag_entity_base,0,0,42,0,0,0,0,",
    "12000,flag_pickup,7,0,0,0,0,0,1,blue",
    "12100,flag_entity_carried,7,0,42,0,0,1,1,",
    "18000,team_score,0,0,0,0,0,0,0,",
    "18100,flag_release,7,0,0,0,0,0,0,",
    "18400,flag_entity_base,0,0,42,0,0,0,0,",
  ].join("\n");
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => csv });
  const options = {
    client,
    channelId: "clips",
    db,
    serverKey: "east",
    matchId: "match1",
    rounds: [1],
    fetchImpl,
  };

  assert.equal((await postCleanFirstPickupClips(options)).length, 1);
  assert.equal((await postCleanFirstPickupClips(options)).length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Clean first pickup/);
  assert.match(sent[0].content, /clipStart=9\.000/);
  db.close();
});

test("automatic clip posting can attach the rendered WebM", async () => {
  const db = new Database(":memory:");
  const sent = [];
  const client = {
    channels: {
      fetch: async () => ({ send: async payload => sent.push(payload) }),
    },
  };
  const csv = [
    "time_ms,event,actor_session,target_session,entity,value1,value2,int_value1,int_value2,text",
    "0,flag_entity_base,0,0,42,0,0,0,0,",
    "12000,flag_pickup,7,0,0,0,0,0,1,blue",
    "12100,flag_entity_carried,7,0,42,0,0,1,1,",
    "18000,team_score,0,0,0,0,0,0,0,",
    "18100,flag_release,7,0,0,0,0,0,0,",
    "18400,flag_entity_base,0,0,42,0,0,0,0,",
  ].join("\n");
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => csv });
  const renderClip = async ({ outputPath }) => {
    await require("node:fs").promises.writeFile(outputPath, Buffer.from("webm"));
  };

  await postCleanFirstPickupClips({
    client,
    channelId: "clips",
    db,
    serverKey: "east",
    matchId: "match1",
    rounds: [1],
    fetchImpl,
    attachWebm: true,
    renderClip,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].files.length, 1);
  assert.match(sent[0].files[0].name, /clean-first-pickup-match1-round-1\.webm/);
  db.close();
});
