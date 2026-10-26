"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { winEmblem, queueWinEmblems } = require("../lib/winEmblems");
const { postQueueBoard } = require("../commands/queue");

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE matches (match_id TEXT PRIMARY KEY, status TEXT, winner TEXT, blue_ids TEXT, red_ids TEXT)`);
  const add = db.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?)");
  return { db, add: (id, winner, blue, red, status = "completed") =>
    add.run(id, status, winner, JSON.stringify(blue), JSON.stringify(red)) };
}

test("elderly Pepe overrides only the selected user and works without win storage", async () => {
  const id = "700890663385956393";
  const pepe = "<:6849_pepeold:1564391283227631666> ";
  assert.equal(queueWinEmblems(null, [id, "other"]).get(id), pepe);
  assert.equal(queueWinEmblems(null, [id, "other"]).has("other"), false);
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 25; i++) add(`win${i}`, "BLUE", [id, "other"], []);
    const badges = queueWinEmblems({ db }, [id, "other"]);
    assert.equal(badges.get(id), pepe);
    assert.equal(badges.get("other"), `${winEmblem(25)} `);
    let sent;
    await postQueueBoard({ send: async payload => { sent = payload; } }, {
      queue: [{ id, name: "Elder" }], offenseQueue: [],
    }, { db }, null);
    assert.equal(sent.embeds[0].toJSON().description, `${pepe}Elder`);
  } finally { db.close(); }
});

test("class milestones promote at the agreed whole-number boundaries", () => {
  const tiers = [[0, "Civilianold_tfc"], [25, "Scoutold_tfc"], [50, "Pyroold_tfc"],
    [75, "Medicold_tfc"], [100, "Spyold_tfc"], [150, "Sniperold_tfc"],
    [375, "Engineerold_tfc"], [750, "Soldierold_tfc"], [1125, "Demomanold_tfc"], [1500, "Heavyold_tfc"]];
  tiers.forEach(([wins, name], index) => {
    assert.ok(winEmblem(wins).startsWith(`<:${name}:`));
    if (index) assert.ok(winEmblem(wins - 1).startsWith(`<:${tiers[index - 1][1]}:`));
  });
  assert.equal(winEmblem(99999), winEmblem(1500));
});

test("wins count completed winning rosters once, refresh after deletion, and default new players to Civilian", () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 25; i++) add(`win${i}`, "BLUE", ["p", "p"], ["loser"]);
    add("redwin", "RED", ["loser"], ["red"]);
    add("draw", "TIE", ["p"], ["red"]);
    add("pending", "BLUE", ["p"], [], "pending");
    const badges = queueWinEmblems({ db }, ["p", "loser", "red", "new"]);
    assert.equal(badges.get("p"), `${winEmblem(25)} `);
    for (const id of ["loser", "red", "new"]) assert.equal(badges.get(id), `${winEmblem(0)} `);
    db.prepare("DELETE FROM matches WHERE match_id = ?").run("win0");
    assert.equal(queueWinEmblems({ db }, ["p"]).get("p"), `${winEmblem(24)} `);
  } finally { db.close(); }
});

test("missing storage omits unverified emblems without breaking rendering", () => {
  assert.equal(queueWinEmblems(null, ["p"]).size, 0);
  const db = new Database(":memory:");
  try { assert.equal(queueWinEmblems({ db }, ["p"]).size, 0); }
  finally { db.close(); }
});

test("queue embeds put emblems before captain/name and offense names, preserving ADL", async () => {
  const { db } = fixture();
  try {
    let sent;
    const channel = { send: async payload => { sent = payload; } };
    const state = { queue: [{ id: "p", name: "Example", captain: true, adlVote: true }],
      offenseQueue: [{ id: "off", name: "Offense" }], elo: { db } };
    await postQueueBoard(channel, state, null, null);
    const embed = sent.embeds[0].toJSON();
    assert.ok(embed.description.startsWith(`${winEmblem(0)} [CAP] Example`));
    assert.ok(embed.description.endsWith(" (ADL)"));
    assert.ok(embed.fields.find(f => f.name.startsWith("Full-time Offense")).value.startsWith(`${winEmblem(0)} Offense`));
    await postQueueBoard(channel, { queue: [] }, null, null);
    assert.equal(sent.embeds[0].toJSON().description, "_empty_");
  } finally { db.close(); }
});

test("removing an ADL vote retains the player's earned emblem on the refreshed board", async () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 25; i++) add(`win${i}`, "RED", [], ["p"]);
    const boards = [];
    const channel = { id: "pickup", send: async payload => {
      if (payload.embeds) boards.push(payload.embeds[0].toJSON());
    } };
    await require("../commands/removeadl").run({ channel, author: { id: "p" } }, {
      state: { queue: [{ id: "p", name: "Example", adlVote: true }] },
      config: { channels: { pickup: "pickup" } }, elo: { db },
    });
    assert.equal(boards[0].description, "<:Scoutold_tfc:1564293700115234856> Example");
  } finally { db.close(); }
});
