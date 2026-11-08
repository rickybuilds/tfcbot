"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("../commands/bootcamp");

test("!license shows the linked player's authoritative license and endorsements", async () => {
  const commands = new Map();
  const sent = [];
  const queries = [];
  register(commands, {
    pool: { query: async (sql, values) => {
      queries.push({ sql, values });
      return [[{ level: "licensed", endorsements: "offense,class:engineer" }]];
    } },
    steamLinks: { getSteamIds: async id => id === "discord-user" ? [{ steam_id: "STEAM_0:1:5" }] : [] },
    config: {},
  });
  await commands.get("license")({
    author: { id: "discord-user" },
    channel: { send: async value => sent.push(value) },
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, ["STEAM_0:1:5"]);
  assert.match(sent[0].embeds[0].data.description, /TFC license/i);
  assert.match(sent[0].embeds[0].data.description, /Offense.*Engineer|Engineer.*Offense/);
  assert.match(sent[0].embeds[0].data.url, /bootcamp\.html\?steamid=STEAM_0%3A1%3A5/);
});

test("!license explains how an unlinked member can get linked", async () => {
  const commands = new Map();
  const sent = [];
  register(commands, { pool: { query: async () => { throw new Error("must not query"); } },
    steamLinks: { getSteamIds: async () => [] }, config: {} });
  await commands.get("license")({ author: { id: "unlinked" }, channel: { send: async value => sent.push(value) } });
  assert.match(sent[0].embeds[0].data.description, /linksteam/i);
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
  const pool = { query: async sql => {
    if (/FROM bootcamp_challenges/i.test(sql)) return [[{ id: 3, title: "Openfire route", map: "openfire", target_type: "route", target_id: 9,
      target_name: "Main Conc", week_start: "2026-11-02", ends_at: "2026-11-09 00:00:00" }]];
    if (/FROM bootcamp_runs/i.test(sql)) return [[{ steamid: "STEAM_0:1:5", player_name: "Runner", class_id: 5, result: 12000 }]];
    throw new Error("Unexpected challenge query");
  } };
  try {
    register(commands, { pool, config: {} });
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
    register(commands, { pool: { query: async () => { throw new Error("must not query"); } }, config: {} });
    await commands.get("challenge")({ channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /not enabled/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_CHALLENGES_ENABLED;
    else process.env.BOOTCAMP_CHALLENGES_ENABLED = original;
  }
});
