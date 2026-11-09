"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBootcampApi } = require("../services/bootcampApi");

test("Bootcamp API client uses the website base path and authenticated event feed", async () => {
  const calls = [];
  const client = {
    async get(url, options) {
      calls.push({ method: "GET", url, options });
      return { data: url.endsWith("/cursor") ? { latestId: 7 } : { events: [{ id: 8 }] } };
    },
    async post(url, body, options) { calls.push({ method: "POST", url, body, options }); return { data: { license: { level: "permit" } } }; }
  };
  const api = createBootcampApi({ baseUrl: "https://example.test/", token: "secret", client });
  assert.equal(await api.latestEventId(), 7);
  assert.equal(calls[0].url, "https://example.test/api/bootcamp/integrations/discord/events/cursor");
  assert.deepEqual(await api.events(7, 25), [{ id: 8 }]);
  assert.equal(calls[1].url, "https://example.test/api/bootcamp/integrations/discord/events");
  assert.deepEqual(calls[1].options.params, { after_id: 7, limit: 25 });
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret");
  assert.deepEqual(await api.recomputeLicense("STEAM_0:1:4"), { level: "permit" });
  assert.equal(calls[2].url, "https://example.test/api/bootcamp/integrations/discord/licenses/recompute");
  assert.deepEqual(calls[2].body, { steamId: "STEAM_0:1:4" });
});

test("Bootcamp API client fails closed when service auth is missing or inputs are invalid", async () => {
  const api = createBootcampApi({ baseUrl: "https://example.test", token: "", client: { get() {}, post() {} } });
  await assert.rejects(api.events(0), /BOOTCAMP_DISCORD_API_TOKEN/);
  await assert.rejects(api.recomputeLicense("bad-id"), /Invalid Steam ID/);
  assert.equal(api.baseUrl, "https://example.test");
});

test("Bootcamp API client records mentor co-signs through the authenticated website endpoint", async () => {
  const calls = [];
  const client = { post: async (...args) => { calls.push(args); return { data: { cosigned: true, steamId: args[1].steamId, mentorDiscordId: args[1].mentorDiscordId } }; } };
  const api = createBootcampApi({ baseUrl: "https://example.test", token: "secret", client });
  await api.cosignLicense("STEAM_0:1:4", "12345678901234567");
  assert.equal(calls[0][0], "https://example.test/api/bootcamp/integrations/discord/licenses/cosign");
  assert.deepEqual(calls[0][1], { steamId: "STEAM_0:1:4", mentorDiscordId: "12345678901234567" });
  assert.equal(calls[0][2].headers.Authorization, "Bearer secret");
  await assert.rejects(api.cosignLicense("invalid", "12345678901234567"), /Invalid Steam ID/);
  await assert.rejects(api.cosignLicense("STEAM_0:1:4", "not-a-discord-id"), /Invalid mentor Discord ID/);
});

test("Bootcamp API client loads the public active season endpoint", async () => {
  const calls = [];
  const client = { get: async (url, options) => { calls.push({ url, options }); return { data: { season: null, standings: [] } }; } };
  const api = createBootcampApi({ baseUrl: "https://example.test", client });
  assert.deepEqual(await api.season(), { season: null, standings: [] });
  assert.equal(calls[0].url, "https://example.test/api/bootcamp/seasons/current");
});

test("Bot runtime Bootcamp commands and watcher never query Bootcamp tables directly", () => {
  const root = path.join(__dirname, "..");
  for (const file of ["services/bootcampWatcher.js", "services/bootcampChallenge.js", "commands/bootcamp.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+bootcamp_[a-z0-9_]+/i,
      `${file} must use the website API boundary`);
    assert.doesNotMatch(source, /\bpool\.query\s*\(/i, `${file} must not issue direct SQL`);
  }
});
