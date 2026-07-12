"use strict";

class OneVOneServerController {
  constructor({ config, runRconCommand }) {
    this.config = config;
    this.runRconCommand = runRconCommand;
  }

  commandsForSetup(reservation) {
    const [p1, p2] = reservation.playerSteamIds;
    return [
      "1v1_enabled 0",
      `1v1_player1 \"${p1}\"`,
      `1v1_player2 \"${p2}\"`,
      `1v1_kill_goal ${this.config.killGoal}`,
      `1v1_rounds_to_win ${this.config.roundsToWin}`,
      `amx_map ${this.config.map}`,
    ];
  }

  commandsForRestore() {
    return ["1v1_enabled 0", '1v1_player1 ""', '1v1_player2 ""'];
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

  setup(reservation) { return this.execute(reservation.serverKey, this.commandsForSetup(reservation)); }
  restore(reservation) { return this.execute(reservation.serverKey, this.commandsForRestore(reservation)); }
}

module.exports = { OneVOneServerController };
