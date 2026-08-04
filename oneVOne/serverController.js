"use strict";

class OneVOneServerController {
  constructor({ config, runRconCommand }) {
    this.config = config;
    this.runRconCommand = runRconCommand;
  }

  commandsForFinishSetup(reservation) {
    const [p1, p2] = reservation.playerSteamIds;
    return [
      "amx_cvar 1v1_enabled 0",
      `amx_cvar 1v1_player1 \"${p1}\"`,
      `amx_cvar 1v1_player2 \"${p2}\"`,
      `amx_cvar 1v1_server_key \"${reservation.serverKey}\"`,
      `amx_cvar 1v1_kill_goal ${this.config.killGoal}`,
      `amx_cvar 1v1_rounds_to_win ${this.config.roundsToWin}`,
      "amx_cvar 1v1_enabled 1",
    ];
  }

  commandsForRestore() {
    const commands = [
      "amx_cvar 1v1_enabled 0",
      'amx_cvar 1v1_player1 ""',
      'amx_cvar 1v1_player2 ""',
      'amx_cvar 1v1_server_key "unknown"',
    ];
    commands.push("amx_map pushNN");
    return commands;
  }

  async execute(serverKey, commands) {
    if (!this.config.serverSetupEnabled) return { ok: true, simulated: true, commands };
    const completed = [];
    for (const command of commands) {
      try {
        await this.runRconCommand(serverKey, command);
        completed.push(command);
      } catch (error) {
        return { ok: false, error, completed, failedCommand: command };
      }
    }
    return { ok: true, simulated: false, commands: completed };
  }

  beginSetup(reservation) {
    // Cvars survive map changes. Disable and clear any previous duel before the
    // change so the freshly loaded plugin cannot start from stale assignments.
    return this.execute(reservation.serverKey, [
      "amx_cvar 1v1_enabled 0",
      'amx_cvar 1v1_player1 ""',
      'amx_cvar 1v1_player2 ""',
      'amx_cvar 1v1_server_key "unknown"',
      `amx_map ${this.config.map}`,
    ]);
  }
  async finishSetup(reservation) {
    if (this.config.serverSetupEnabled) {
      await new Promise(resolve => setTimeout(resolve, this.config.postMapSetupDelayMs));
    }
    return this.execute(reservation.serverKey, this.commandsForFinishSetup(reservation));
  }
  restore(reservation) { return this.execute(reservation.serverKey, this.commandsForRestore(reservation)); }
}

module.exports = { OneVOneServerController };
