"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("../commands/bootcamp");

test("!license shows the linked player's authoritative license and endorsements", async () => {
  const commands = new Map();
  const sent = [];
  register(commands, {
    api: { player: async steamId => ({ steamId, license: { level: "licensed", endorsements: ["offense", "class:engineer"], cosignedBy: "12345678901234567" } }) },
    steamLinks: { getSteamIds: async id => id === "discord-user" ? [{ steam_id: "STEAM_0:1:5" }] : [] },
    config: {},
  });
  await commands.get("license")({
    author: { id: "discord-user" },
    channel: { send: async value => sent.push(value) },
  });
  assert.match(sent[0].embeds[0].data.description, /TFC license/i);
  assert.match(sent[0].embeds[0].data.description, /Offense.*Engineer|Engineer.*Offense/);
  assert.match(sent[0].embeds[0].data.description, /Mentor co-sign/);
  assert.match(sent[0].embeds[0].data.url, /bootcamp\.html\?steamid=STEAM_0%3A1%3A5/);
});

test("!license explains how an unlinked member can get linked", async () => {
  const commands = new Map();
  const sent = [];
  register(commands, { api: { player: async () => { throw new Error("must not query"); } },
    steamLinks: { getSteamIds: async () => [] }, config: {} });
  await commands.get("license")({ author: { id: "unlinked" }, channel: { send: async value => sent.push(value) } });
  assert.match(sent[0].embeds[0].data.description, /linksteam/i);
});

test("!license shows self-service linking only when an HTTPS link URL is configured", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_ACCOUNT_LINK_URL;
  process.env.BOOTCAMP_ACCOUNT_LINK_URL = "https://noname.example/bootcamp.html";
  try {
    register(commands, { api: {}, steamLinks: { getSteamIds: async () => [] }, config: {} });
    await commands.get("license")({ author: { id: "unlinked" }, channel: { send: async value => sent.push(value) } });
    assert.match(sent[0].embeds[0].data.description, /Link Steam and Discord/);
    assert.match(sent[0].embeds[0].data.description, /https:\/\/noname\.example\/bootcamp\.html/);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_ACCOUNT_LINK_URL;
    else process.env.BOOTCAMP_ACCOUNT_LINK_URL = original;
  }
});

test("!learning stays disabled until the eligibility flag is enabled", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
  delete process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
  try {
    register(commands, { api: { player: async () => { throw new Error("must not query"); } },
      steamLinks: { getSteamIds: async () => [{ steam_id: "STEAM_0:1:5" }] }, config: {} });
    await commands.get("learning")({ author: { id: "trainee" }, channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /not enabled/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
    else process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED = original;
  }
});

test("!learning verifies the linked player's learner permit through the website API", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
  process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED = "true";
  try {
    register(commands, {
      api: { player: async steamId => ({ steamId, license: { level: "permit", endorsements: [] } }) },
      steamLinks: { getSteamIds: async () => [{ steam_id: "STEAM_0:1:5" }] }, config: {}
    });
    await commands.get("learning")({ author: { id: "trainee" }, channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /eligible for learning pugs/i);
    assert.match(sent[0], /Learner's permit/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
    else process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED = original;
  }
});

test("!learning explains that a permit is still needed", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
  process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED = "true";
  try {
    register(commands, {
      api: { player: async steamId => ({ steamId, license: { level: "none", endorsements: [] } }) },
      steamLinks: { getSteamIds: async () => [{ steam_id: "STEAM_0:1:5" }] }, config: {}
    });
    await commands.get("learning")({ author: { id: "trainee" }, channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /need a learner's permit/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED;
    else process.env.BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED = original;
  }
});

test("!learning join stays disabled by default and does not touch waitlist storage", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
  delete process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
  try {
    register(commands, { api: {}, steamLinks: {
      getSteamIds: async () => { throw new Error("must not read identity"); },
      joinBootcampLearningQueue: async () => { throw new Error("must not write waitlist"); },
    }, config: { bootcampLearningQueueEnabled: false } });
    await commands.get("learning")({ author: { id: "10000000000000001" }, channel: { id: "learning", send: async v => sent.push(v) } }, ["join"]);
    assert.match(sent[0], /learning-pug waitlist is not enabled/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
    else process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED = original;
  }
});

test("!learning join adds only permit holders to the dedicated waitlist", async () => {
  const commands = new Map();
  const sent = [];
  const calls = [];
  const original = process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
  process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED = "true";
  try {
    register(commands, {
      api: { player: async steamId => ({ steamId, license: { level: "permit", endorsements: [] } }) },
      steamLinks: {
        getSteamIds: async () => [{ steam_id: "STEAM_0:1:5", is_primary: 1 }],
        joinBootcampLearningQueue: async (discordId, steamId) => { calls.push([discordId, steamId]); return { changes: 1 }; },
        getBootcampLearningQueue: async () => [{ discord_id: "10000000000000001" }, { discord_id: "10000000000000002" }],
      },
      config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, bootcampLearningQueueSize: 8, roles: {} },
    });
    await commands.get("learning")({ author: { id: "10000000000000001" }, channel: { id: "learning-channel", send: async v => sent.push(v) } }, ["join"]);
    assert.deepEqual(calls, [["10000000000000001", "STEAM_0:1:5"]]);
    assert.match(sent[0], /learning-pug waitlist/i);
    assert.match(sent[0], /1\/8/);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
    else process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED = original;
  }
});

test("!learning join refuses a player without a learner permit", async () => {
  const commands = new Map();
  const sent = [];
  let writes = 0;
  const original = process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
  process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED = "true";
  try {
    register(commands, {
      api: { player: async steamId => ({ steamId, license: { level: "none", endorsements: [] } }) },
      steamLinks: { getSteamIds: async () => [{ steam_id: "STEAM_0:1:5" }], joinBootcampLearningQueue: async () => { writes++; } },
      config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, roles: {} },
    });
    await commands.get("learning")({ author: { id: "10000000000000001" }, channel: { id: "learning-channel", send: async v => sent.push(v) } }, ["join"]);
    assert.equal(writes, 0);
    assert.match(sent[0], /need a learner's permit/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED;
    else process.env.BOOTCAMP_LEARNING_QUEUE_ENABLED = original;
  }
});

test("learning waitlist commands stay inside the configured channel", async () => {
  const commands = new Map();
  const sent = [];
  let reads = 0;
  register(commands, { api: {}, steamLinks: { getSteamIds: async () => { reads++; return []; } },
    config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, roles: {} } });
  await commands.get("learning")({ author: { id: "10000000000000001" }, channel: { id: "pickup-channel", send: async value => sent.push(value) } }, ["join"]);
  assert.deepEqual(sent, ["Use the learning-pug waitlist in <#learning-channel>."]);
  assert.equal(reads, 0);
});

test("only learning-pug organizers or admins can inspect the waitlist", async () => {
  const commands = new Map();
  const sent = [];
  let reads = 0;
  register(commands, { api: {}, steamLinks: { getBootcampLearningQueue: async () => { reads++; return []; } },
    config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, roles: { admin: "admin", bootcampLearningOrganizer: "organizer" } } });
  await commands.get("learning")({ author: { id: "10000000000000001" }, member: { roles: { cache: new Set() } },
    channel: { id: "learning-channel", send: async value => sent.push(value) } }, ["list"]);
  assert.deepEqual(sent, ["Only configured learning-pug organizers can manage the waitlist."]);
  assert.equal(reads, 0);
});

test("learning-pug organizers can clear the waitlist after scheduling a session", async () => {
  const commands = new Map();
  const sent = [];
  let cleared = 0;
  register(commands, { api: {}, steamLinks: { clearBootcampLearningQueue: async () => { cleared++; return { changes: 3 }; } },
    config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, roles: { bootcampLearningOrganizer: "organizer" } } });
  await commands.get("learning")({ author: { id: "10000000000000001" }, member: { roles: { cache: new Set(["organizer"]) } },
    channel: { id: "learning-channel", send: async value => sent.push(value) } }, ["clear"]);
  assert.equal(cleared, 1);
  assert.match(sent[0], /cleared \(3 signups removed\)/i);
});

test("filling the learning-pug waitlist notifies the configured organizer role once", async () => {
  const commands = new Map();
  const sent = [];
  const before = Array.from({ length: 7 }, (_, index) => ({ discord_id: String(10000000000000001n + BigInt(index)) }));
  let joined = false;
  register(commands, {
    api: { player: async steamId => ({ steamId, license: { level: "permit", endorsements: [] } }) },
    steamLinks: {
      getSteamIds: async () => [{ steam_id: "STEAM_0:1:5", is_primary: 1 }],
      joinBootcampLearningQueue: async () => { joined = true; return { changes: 1 }; },
      getBootcampLearningQueue: async () => joined
        ? [...before, { discord_id: "10000000000000008" }]
        : before,
    },
    config: { bootcampLearningQueueEnabled: true, channels: { learningQueue: "learning-channel" }, bootcampLearningQueueSize: 8,
      roles: { bootcampLearningOrganizer: "organizer-role" } },
  });
  await commands.get("learning")({ author: { id: "10000000000000008" }, channel: { id: "learning-channel", send: async value => sent.push(value) } }, ["join"]);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /<@&organizer-role>/);
  assert.match(sent[1], /reached 8 players/);
});

test("!bootcamp provides the training hub and in-game start command", async () => {
  const commands = new Map();
  const sent = [];
  register(commands, { config: {} });
  await commands.get("bootcamp")({ channel: { send: async value => sent.push(value) } });
  assert.match(sent[0], /bootcamp\.html/i);
  assert.match(sent[0], /tt_lessons/i);
});

test("!challenge shows the active weekly challenge and its standings when enabled", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_CHALLENGES_ENABLED;
  process.env.BOOTCAMP_CHALLENGES_ENABLED = "true";
  const api = { challenge: async () => ({ challenge: { id: 3, title: "Openfire route", map: "openfire", targetType: "route", targetId: 9,
    targetName: "Main Conc", weekStart: "2026-11-02", endsAt: "2026-11-09 00:00:00" },
  standings: [{ steamId: "STEAM_0:1:5", playerName: "Runner", classId: 5, timeMs: 12000, score: null }] }) };
  try {
    register(commands, { api, config: {} });
    await commands.get("challenge")({ channel: { send: async value => sent.push(value) } });
    assert.match(sent[0].embeds[0].data.title, /weekly.*challenge/i);
    assert.match(sent[0].embeds[0].data.description, /Openfire route/);
    assert.match(sent[0].embeds[0].data.description, /Runner.*12\.000s/);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_CHALLENGES_ENABLED;
    else process.env.BOOTCAMP_CHALLENGES_ENABLED = original;
  }
});

test("!challenge stays disabled until explicitly enabled", async () => {
  const commands = new Map();
  const sent = [];
  const original = process.env.BOOTCAMP_CHALLENGES_ENABLED;
  delete process.env.BOOTCAMP_CHALLENGES_ENABLED;
  try {
    register(commands, { api: { challenge: async () => { throw new Error("must not query"); } }, config: {} });
    await commands.get("challenge")({ channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /not enabled/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_CHALLENGES_ENABLED;
    else process.env.BOOTCAMP_CHALLENGES_ENABLED = original;
  }
});
