"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OneVOneServerController } = require("../oneVOne/serverController");

const reservation = { serverKey: "east", playerSteamIds: ["STEAM_0:0:1", "STEAM_0:1:2"] };

function controller(runRconCommand) {
  return new OneVOneServerController({
    config: { serverSetupEnabled: true, postMapSetupDelayMs: 1, killGoal: 50, roundsToWin: 1 },
    runRconCommand,
  });
}

test("duel setup pauses suicide grenades alongside player assignments before enabling play", async () => {
  const sent = [];
  const result = await controller(async (server, command) => sent.push([server, command])).finishSetup(reservation);
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    ["east", "amx_cvar 1v1_enabled 0"],
    ["east", "amx_pausecfg pause suinades2.amxx"],
    ["east", 'amx_cvar 1v1_player1 "STEAM_0:0:1"'],
    ["east", 'amx_cvar 1v1_player2 "STEAM_0:1:2"'],
    ["east", 'amx_cvar 1v1_server_key "east"'],
    ["east", "amx_cvar 1v1_kill_goal 50"],
    ["east", "amx_cvar 1v1_rounds_to_win 1"],
    ["east", "amx_cvar 1v1_enabled 1"],
  ]);
});

test("restoration enables suicide grenades after disabling the duel and before changing map", async () => {
  const sent = [];
  const result = await controller(async (server, command) => sent.push(command)).restore(reservation);
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    "amx_cvar 1v1_enabled 0",
    'amx_cvar 1v1_player1 ""',
    'amx_cvar 1v1_player2 ""',
    'amx_cvar 1v1_server_key "unknown"',
    "amx_pausecfg enable suinades2.amxx",
    "amx_map pushNN",
  ]);
});

test("a rejected pause RCON command prevents the duel from being enabled", async () => {
  const sent = [];
  const result = await controller(async (server, command) => {
    sent.push(command);
    if (command === "amx_pausecfg pause suinades2.amxx") throw new Error("RCON unavailable");
  }).finishSetup(reservation);
  assert.equal(result.ok, false);
  assert.equal(result.failedCommand, "amx_pausecfg pause suinades2.amxx");
  assert.equal(sent.includes("amx_cvar 1v1_enabled 1"), false);
});
