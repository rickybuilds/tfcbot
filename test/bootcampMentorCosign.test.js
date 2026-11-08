"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { register } = require("../commands/bootcamp");

function makeMessage({ authorId = "mentor", targetId = "player", hasRole = true } = {}) {
  const sent = [];
  return {
    sent,
    message: {
      author: { id: authorId },
      member: { roles: { cache: { has: id => hasRole && id === "mentor-role" } } },
      mentions: { users: { first: () => ({ id: targetId }) } },
      channel: { send: async value => sent.push(value) }
    }
  };
}

test("!cosign is disabled unless explicitly enabled", async () => {
  const commands = new Map();
  const { message, sent } = makeMessage();
  register(commands, { api: { cosignLicense: async () => { throw new Error("must remain disabled"); } },
    steamLinks: {}, config: { bootcampMentorCosignEnabled: false, roles: { bootcampMentor: "mentor-role" } } });
  await commands.get("cosign")(message, []);
  assert.match(sent[0], /not enabled/i);
});

test("!cosign requires the mentor role and the target's primary linked Steam ID", async () => {
  const commands = new Map();
  const sent = [];
  const calls = [];
  register(commands, {
    api: { cosignLicense: async (...args) => { calls.push(args); return { cosigned: true }; } },
    steamLinks: { getSteamIds: async id => id === "player" ? [
      { steam_id: "STEAM_0:1:22", is_primary: 1 }, { steam_id: "STEAM_0:1:23", is_primary: 0 }
    ] : [] },
    config: { bootcampMentorCosignEnabled: true, roles: { bootcampMentor: "mentor-role" } }
  });
  const unauthorized = makeMessage({ hasRole: false });
  await commands.get("cosign")(unauthorized.message, []);
  assert.match(unauthorized.sent[0], /mentor role/i);
  assert.equal(calls.length, 0);

  const valid = makeMessage();
  valid.message.channel.send = async value => { sent.push(value); };
  await commands.get("cosign")(valid.message, []);
  assert.deepEqual(calls, [["STEAM_0:1:22", "mentor"]]);
  assert.match(sent[0], /co-sign recorded/i);
});

test("!cosign rejects self-signs and unlinked targets", async () => {
  const commands = new Map();
  register(commands, { api: { cosignLicense: async () => { throw new Error("must not cosign"); } },
    steamLinks: { getSteamIds: async () => [] }, config: { bootcampMentorCosignEnabled: true, roles: { bootcampMentor: "mentor-role" } } });
  const self = makeMessage({ targetId: "mentor" });
  await commands.get("cosign")(self.message, []);
  assert.match(self.sent[0], /yourself/i);
  const unlinked = makeMessage({ targetId: "unlinked" });
  await commands.get("cosign")(unlinked.message, []);
  assert.match(unlinked.sent[0], /link.*Steam/i);
});

test("mentor co-sign flag and role default safely off without configuration", () => {
  const envFlag = process.env.BOOTCAMP_MENTOR_COSIGN_ENABLED;
  const envRole = process.env.BOOTCAMP_MENTOR_ROLE_ID;
  delete process.env.BOOTCAMP_MENTOR_COSIGN_ENABLED;
  delete process.env.BOOTCAMP_MENTOR_ROLE_ID;
  try {
    delete require.cache[require.resolve("../config")];
    const config = require("../config");
    assert.equal(config.bootcampMentorCosignEnabled, false);
    assert.equal(config.roles.bootcampMentor, "");
  } finally {
    if (envFlag === undefined) delete process.env.BOOTCAMP_MENTOR_COSIGN_ENABLED;
    else process.env.BOOTCAMP_MENTOR_COSIGN_ENABLED = envFlag;
    if (envRole === undefined) delete process.env.BOOTCAMP_MENTOR_ROLE_ID;
    else process.env.BOOTCAMP_MENTOR_ROLE_ID = envRole;
    delete require.cache[require.resolve("../config")];
  }
});
