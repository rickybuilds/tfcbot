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
  updateScorePair,
  isPickupServerKey,
  isTrackingOnlyServerKey,
  shouldWarnBlockedPickupSource,
} = require("../services/hldsLogs");
const {
  register: registerMatches,
  getLastMatchesLimit,
  getPlayerGameState,
  getPlayerGameButtonSpec,
} = require("../commands/matches");

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
  rconServers.testMm2 = { host: "192.0.2.200", port: 27016, trackingOnly: true };

  try {
    assert.equal(serverKeyForSource("192.0.2.200", 27015), "testMm1");
    assert.equal(serverKeyForSource("192.0.2.200", 27016), "testMm2");
    assert.equal(serverKeyForSource("192.0.2.200", 9999), null);
  } finally {
    delete rconServers.testMm1;
    delete rconServers.testMm2;
  }
});

test("tracking-only endpoints cannot cross the pickup lifecycle boundary", () => {
  rconServers.testPickup = { host: "192.0.2.201", port: 27015 };
  rconServers.testSkills = { host: "192.0.2.201", port: 27016, trackingOnly: true };

  try {
    assert.equal(isPickupServerKey("testPickup"), true);
    assert.equal(isTrackingOnlyServerKey("testPickup"), false);
    assert.equal(isPickupServerKey("testSkills"), false);
    assert.equal(isTrackingOnlyServerKey("testSkills"), true);
    assert.equal(shouldWarnBlockedPickupSource("testSkills"), false);
    assert.equal(shouldWarnBlockedPickupSource("testPickup"), false);
    assert.equal(shouldWarnBlockedPickupSource("missingServer"), true);
  } finally {
    delete rconServers.testPickup;
    delete rconServers.testSkills;
  }
});

test("RCON queue notices cannot inject quotes or new commands", () => {
  assert.equal(
    safeRconText('Player"\nquit\r now'),
    "Player quit now"
  );
});

test("registers lastmatches aliases", () => {
  const registry = new Map();

  registerMatches(registry);

  assert.equal(registry.has("lastmatches"), true);
  assert.equal(registry.get("lastgames"), registry.get("lastmatches"));
  assert.notEqual(registry.get("last"), registry.get("lastmatches"));
});

test("lastmatches defaults to seven games and preserves the optional cap", () => {
  assert.equal(getLastMatchesLimit([]), 7);
  assert.equal(getLastMatchesLimit(["3"]), 3);
  assert.equal(getLastMatchesLimit(["99"]), 10);
  assert.equal(getLastMatchesLimit(["not-a-number"]), 7);
});

test("lastgames queries and displays seven games by default", async () => {
  let requestedLimit;
  const sent = [];
  const rows = Array.from({ length: 7 }, (_, index) => ({
    match_id: `match-${index + 1}`,
    winner: "blue",
    created_at: 1,
    map_name: "2fort",
    status: "completed",
  }));
  const database = {
    prepare(sql) {
      assert.match(sql, /ORDER BY created_at DESC LIMIT \?/);
      return { all: limit => (requestedLimit = limit, rows) };
    },
  };
  const registry = new Map();
  registerMatches(registry, {
    config: { channels: { pickup: "pickup" } },
    elo: { db: database },
  });

  await registry.get("lastgames")({
    channel: {
      id: "pickup",
      send: async message => sent.push(message),
    },
  }, []);

  assert.equal(requestedLimit, 7);
  assert.equal(sent[0].split("\n").length, 8);
});

test("player game states combine result and MVP status", () => {
  const cases = [
    ["blue", "BLUE", false, "win"],
    ["blue", "BLUE", true, "win_mvp"],
    ["blue", "TIE", false, "tie"],
    ["blue", "TIE", true, "tie_mvp"],
    ["blue", "RED", false, "loss"],
    ["blue", "RED", true, "loss_mvp"],
  ];

  for (const [team, winner, isMvp, expected] of cases) {
    assert.equal(
      getPlayerGameState({ blue_ids: team === "blue" ? '["42"]' : "[]", red_ids: "[]", winner }, "42", isMvp),
      expected
    );
  }
});

test("player game indicators use the six requested visual states", () => {
  const specs = [
    ["win", "🟢"],
    ["win_mvp", "🟣"],
    ["tie", "🟡"],
    ["tie_mvp", "😐"],
    ["loss", "🔴"],
    ["loss_mvp", "😢"],
  ];

  for (const [state, emoji] of specs) {
    assert.equal(getPlayerGameButtonSpec(state).emoji, emoji);
  }
});

test("!last @user renders the player's latest ten games on one line with a record", async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    match_id: `match-${index + 1}`,
    winner: index % 2 ? "red" : "blue",
    created_at: 10 - index,
    map_name: "2fort",
    status: "completed",
    blue_ids: '["42"]',
    red_ids: "[]",
  }));
  const sent = [];
  const database = {
    prepare(sql) {
      if (sql.includes("FROM matches")) return { all: () => rows };
      if (sql.includes("FROM player_steam_ids")) return { all: () => [{ steam_id: "STEAM_0:1:42" }] };
      if (sql.includes("FROM match_round_mvps")) return { all: () => [{ match_id: "match-1", mvp_player_key: "STEAM_0:1:42" }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const registry = new Map();
  registerMatches(registry, {
    config: { channels: { pickup: "pickup" } },
    elo: { db: database },
  });

  await registry.get("last")({
    mentions: { users: { first: () => ({ id: "42" }) } },
    channel: {
      id: "pickup",
      send: async message => sent.push(message),
    },
  }, []);

  assert.equal(sent.length, 1);
  assert.equal(sent[0], "Last 10: 🟣 🔴 🟢 🔴 🟢 🔴 🟢 🔴 🟢 🔴 W-L-T(5-5-0)");
});

test("score pairing never combines pickup and SKILLS endpoints sharing an IP", () => {
  const pairs = new Map();
  const pickup = { sourceKey: "testMm1", serverKey: "testMm1", from: "192.0.2.200", sourcePort: 27015 };
  const skill = { sourceKey: "testMm2", serverKey: "testMm2", from: "192.0.2.200", sourcePort: 27016 };

  assert.equal(updateScorePair(pairs, { ...pickup, type: "score", team: "Blue", score: 80, ts: 1000 }), null);
  assert.equal(updateScorePair(pairs, { ...skill, type: "score", team: "Red", score: 20, ts: 1001 }), null);
  assert.equal(updateScorePair(pairs, { ...pickup, type: "score", team: "Red", score: 0, ts: 1002 }).serverKey, "testMm1");
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
  assert.doesNotMatch(queueBoard.data.description, /Added to queue via/);
  assert.equal(
    sentToDiscord[0],
    `<@${discordId}> joined the queue from mm1.`
  );

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
