"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  register,
  notifyHldsVoteStarted,
  parseHldsQueueCommand,
  safeRconText,
} = require("../commands/queue");
const rconServers = require("../config/rcon");
const {
  parseLine,
  serverKeyForSource,
} = require("../services/hldsLogs");

test("recognizes regular in-game queue commands", () => {
  assert.deepEqual(parseHldsQueueCommand("!add"), { action: "add", adl: false });
  assert.deepEqual(parseHldsQueueCommand(" ++ "), { action: "add", adl: false });
});

test("recognizes all in-game ADL queue commands", () => {
  for (const command of ["!addadl", "++adl", "**"]) {
    assert.deepEqual(parseHldsQueueCommand(command), { action: "add", adl: true });
  }
});

test("recognizes in-game queue removal commands", () => {
  assert.deepEqual(parseHldsQueueCommand("!remove"), { action: "remove", adl: false });
  assert.deepEqual(parseHldsQueueCommand("--"), { action: "remove", adl: false });
  assert.equal(parseHldsQueueCommand("!vote 1"), null);
});

test("HLDS say and disconnect events retain the Steam ID needed by the queue bridge", () => {
  const say = parseLine(
    '"Player<7><STEAM_0:1:12345><Blue>" say "!addadl"'
  );
  assert.equal(say.type, "say");
  assert.equal(say.steamid, "STEAM_0:1:12345");
  assert.equal(say.text, "!addadl");

  const disconnect = parseLine(
    '"Player<7><STEAM_0:1:12345><Blue>" disconnected'
  );
  assert.equal(disconnect.type, "disconnect");
  assert.equal(disconnect.steamid, "STEAM_0:1:12345");
});

test("distinguishes two configured game servers sharing one IP by source port", () => {
  rconServers.testMm1 = { host: "192.0.2.200", port: 27015 };
  rconServers.testMm2 = { host: "192.0.2.200", port: 27016 };

  try {
    assert.equal(serverKeyForSource("192.0.2.200", 27015), "testMm1");
    assert.equal(serverKeyForSource("192.0.2.200", 27016), "testMm2");
    assert.equal(serverKeyForSource("192.0.2.200", 9999), null);
  } finally {
    delete rconServers.testMm1;
    delete rconServers.testMm2;
  }
});

test("RCON queue notices cannot inject quotes or new commands", () => {
  assert.equal(
    safeRconText('Player"\nquit\r now'),
    "Player quit now"
  );
});

test("vote start notifies each server represented by in-game players once", async () => {
  const sent = [];
  const players = [
    { queueOrigin: "hlds", sourceServerKey: "east" },
    { queueOrigin: "hlds", sourceServerKey: "east" },
    { queueOrigin: "hlds", sourceServerKey: "west" },
    { queueOrigin: "discord" },
  ];

  const count = await notifyHldsVoteStarted(
    players,
    async (serverKey, command) => sent.push({ serverKey, command })
  );

  assert.equal(count, 2);
  assert.deepEqual(sent, [
    {
      serverKey: "east",
      command: 'say "[Queue] Vote started! Vote in Discord now."',
    },
    {
      serverKey: "west",
      command: 'say "[Queue] Vote started! Vote in Discord now."',
    },
  ]);
});

test("linked HLDS players join by Discord ID and leave on disconnect", async () => {
  const discordId = "123456789012345678";
  const sentToDiscord = [];
  const sentToRcon = [];
  const member = {
    id: discordId,
    displayName: "Linked Player",
    user: { id: discordId, tag: "linked#0001" },
  };
  const channel = {
    id: "pickup",
    guild: {
      members: {
        fetch: async id => id === discordId ? member : null,
      },
    },
    isTextBased: () => true,
    send: async payload => {
      sentToDiscord.push(payload);
      return {};
    },
  };
  const client = {
    channels: { fetch: async () => channel },
    guilds: { cache: new Map() },
  };
  const state = {
    MAX_PLAYERS: 8,
    queue: [],
    lockedPlayers: new Map(),
    bannedUsers: new Set(),
    ghostBans: {},
  };
  const registry = new Map();
  registry.client = client;
  registry.persistQueueSoon = () => {};

  register(registry, {
    client,
    config: { channels: { pickup: "pickup" } },
    state,
    elo: { getRating: () => 1941 },
    banStore: { getBan: () => null },
    settings: { getNumber: (_key, fallback) => fallback },
    privacy: { isHidden: () => false },
    steamLinks: {
      getDiscordBySteam: async steamId =>
        steamId === "STEAM_0:1:99999" ? [] : [{ discord_id: discordId }],
    },
    runRconCommand: async (serverKey, command) => {
      sentToRcon.push({ serverKey, command });
    },
  });

  const missingLinkHandled = await registry.handleHldsQueueEvent({
    type: "say",
    text: "!add",
    player: "ricky",
    steamid: "STEAM_0:1:99999",
    from: "192.0.2.10",
    serverKey: "mm1",
  });

  assert.equal(missingLinkHandled, true);
  assert.equal(sentToRcon[0].command, 'say "[Queue] ricky: link Steam to Discord first."');
  assert.ok(sentToRcon[0].command.length < 64);
  sentToRcon.length = 0;

  const addHandled = await registry.handleHldsQueueEvent({
    type: "say",
    text: "!add",
    player: "Game Player",
    steamid: "STEAM_0:1:12345",
    from: "192.0.2.10",
    serverKey: "mm1",
  });

  assert.equal(addHandled, true);
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].id, discordId);
  assert.equal(state.queue[0].queueOrigin, "hlds");
  assert.equal(state.queue[0].sourceServerKey, "mm1");
  assert.equal(state.queue[0].steamId, "STEAM_0:1:12345");
  assert.match(sentToRcon[0].command, /added to the queue/i);
  assert.ok(sentToDiscord.length >= 1);
  const queueBoard = sentToDiscord.find(payload => payload.embeds)?.embeds[0];
  assert.match(queueBoard.data.description, /Linked Player/);
  assert.match(queueBoard.data.description, /Added to queue via: `mm1`/);

  const disconnectHandled = await registry.handleHldsQueueEvent({
    type: "disconnect",
    player: "Game Player",
    steamid: "STEAM_0:1:12345",
    from: "192.0.2.10",
    serverKey: "mm1",
  });

  assert.equal(disconnectHandled, false);
  assert.equal(state.queue.length, 0);
});
