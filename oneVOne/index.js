"use strict";

const { loadOneVOneConfig } = require("./config");
const { ServerReservations } = require("./reservations");
const { parseOneVOneLogLine } = require("./logParser");
const { DuelManager } = require("./manager");
const { registerCommands } = require("./commands");

function createOneVOneSubsystem(deps) {
  const config = loadOneVOneConfig();
  const reservations = new ServerReservations(deps.state);
  const manager = new DuelManager({ config, state: deps.state, steamLinks: deps.steamLinks, reservations });

  function register() {
    if (!config.enabled) {
      console.log("[1v1] disabled (ONEVONE_ENABLED is not set)");
      return;
    }
    console.log(`[1v1] enabled dryRun=${config.dryRun} serverSetup=${config.serverSetupEnabled}`);
    registerCommands(deps.registry, { config, manager });
  }

  async function onHldsEvent(evt) {
    if (!config.enabled || evt.type !== "one_v_one_match_end") return false;
    console.log(`[1v1] received match end from ${evt.from || "unknown"}; completion pipeline not enabled yet`);
    return true;
  }

  return { config, reservations, manager, register, onHldsEvent, parseOneVOneLogLine };
}

module.exports = { createOneVOneSubsystem };
