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
