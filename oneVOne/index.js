"use strict";

const { loadOneVOneConfig } = require("./config");
const { ServerReservations } = require("./reservations");
const { parseOneVOneLogLine } = require("./logParser");
const { DuelManager } = require("./manager");
const { registerCommands } = require("./commands");
const { OneVOneStore } = require("./store");
const { createCompletionHandler } = require("./completion");
const { resolveServerKey } = require("./serverResolver");
const rconServers = require("../config/rcon");
const { OneVOneServerController } = require("./serverController");

function createOneVOneSubsystem(deps) {
  const config = loadOneVOneConfig();
  const reservations = new ServerReservations(deps.state);
  let store = null;
  if (config.enabled && deps.matchesStore?.db) {
    const candidate = new OneVOneStore(deps.matchesStore.db);
    const schema = candidate.schemaStatus();
    if (schema.duelTable) store = candidate;
    else console.warn("[1v1] database migration has not been applied; persistence disabled");
  }
  const serverController = new OneVOneServerController({ config, runRconCommand: deps.runRconCommand });
  const manager = new DuelManager({ config, state: deps.state, steamLinks: deps.steamLinks, reservations, store,
    resolveServer: server => resolveServerKey(server, rconServers), serverController });
  let completion = null;
  function attachCompletion({ client, logsChannelId }) {
    if (!config.enabled) return false;
    completion = createCompletionHandler({ client, matchesStore: deps.matchesStore, logsChannelId, manager });
    return true;
  }

  function register() {
    if (!config.enabled) {
      console.log("[1v1] disabled (ONEVONE_ENABLED is not set)");
      return;
    }
    console.log(`[1v1] enabled dryRun=${config.dryRun} serverSetup=${config.serverSetupEnabled}`);
    registerCommands(deps.registry, { config, manager, adminRoleId: deps.config.roles.admin });
    console.log(`[1v1] restored pending challenges=${manager.restorePending()}`);
  }

  async function onHldsEvent(evt) {
    if (!config.enabled || evt.type !== "one_v_one_match_end") return false;
    const match = manager.findReservationForEvent(evt);
    if (!match.ok) {
      console.warn(`[1v1] rejected match end reason=${match.reason} from=${evt.from || "unknown"}`);
      return true;
    }
    if (completion) await completion(evt, match);
    else if (typeof deps.onOneVOneMatchEnd === "function") await deps.onOneVOneMatchEnd(evt, match);
    else console.log(`[1v1] verified match end reservation=${match.reservation.id}; completion adapter not attached`);
    return true;
  }

  return { config, reservations, manager, register, attachCompletion, onHldsEvent, parseOneVOneLogLine };
}

module.exports = { createOneVOneSubsystem };
