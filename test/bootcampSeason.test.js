"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("../commands/bootcamp");

test("!season remains unavailable until the season feature flag is enabled", async () => {
  const commands = new Map(), sent = [];
  const original = process.env.BOOTCAMP_SEASONS_ENABLED;
  delete process.env.BOOTCAMP_SEASONS_ENABLED;
  try {
    register(commands, { api: { season: async () => { throw new Error("disabled feature must not call API"); } }, config: {} });
    await commands.get("season")({ channel: { send: async value => sent.push(value) } });
    assert.match(sent[0], /season standings are not enabled/i);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_SEASONS_ENABLED;
    else process.env.BOOTCAMP_SEASONS_ENABLED = original;
  }
});

test("!season displays current standings from the website API", async () => {
  const commands = new Map(), sent = [];
  const original = process.env.BOOTCAMP_SEASONS_ENABLED;
  process.env.BOOTCAMP_SEASONS_ENABLED = "true";
  try {
    register(commands, { api: { season: async () => ({ season: { title: "Winter 2026", startsAt: "2026-11-01 00:00:00", endsAt: "2027-02-01 00:00:00" },
      standings: [{ rank: 1, steamId: "STEAM_0:1:5", playerName: "Runner", points: 8, objectives: 3 }] }) }, config: {} });
    await commands.get("season")({ channel: { send: async value => sent.push(value) } });
    const embed = sent[0].embeds[0].data;
    assert.match(embed.title, /Winter 2026/);
    assert.match(embed.description, /Runner.*8 points.*3 objectives/);
  } finally {
    if (original === undefined) delete process.env.BOOTCAMP_SEASONS_ENABLED;
    else process.env.BOOTCAMP_SEASONS_ENABLED = original;
  }
});
