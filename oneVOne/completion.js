"use strict";

const { downloadAndUploadLogs } = require("../services/hldsTransfer");
const { sendRecapWithDemos } = require("../services/discordUpload");

function createCompletionHandler({ client, matchesStore, logsChannelId, manager }) {
  return async function completeOneVOne(evt, match) {
    const reservation = match.reservation;
    const matchId = reservation.id;
    const result = await downloadAndUploadLogs({
      filenames: reservation.logFiles || [],
      matchId,
      map: evt.map,
      server: reservation.serverKey || evt.server,
    });
    const hampalyzerUrl = result.upload?.url || null;
    const tfcstatsUrl = result.tfcstats?.url || null;
    matchesStore.db.prepare(`UPDATE matches SET hampalyzer_url=?, tfcstats_url=?, status='completed', processed_at=? WHERE match_id=?`)
      .run(hampalyzerUrl, tfcstatsUrl, Math.floor(Date.now() / 1000), matchId);
    matchesStore.db.prepare(`UPDATE one_v_one_matches SET winner_steam_id=?, loser_steam_id=?,
      winner_score=?, loser_score=?, duration_seconds=?, status='completed', completed_at=? WHERE match_id=?`)
      .run(evt.winner, evt.loser, evt.winner_score, evt.loser_score, evt.duration, Date.now(), matchId);
    const [p1Discord, p2Discord] = reservation.playerDiscordIds;
    const [p1Steam, p2Steam] = reservation.playerSteamIds;
    const winnerIsP1 = String(evt.winner).toUpperCase() === String(p1Steam).toUpperCase();
    await sendRecapWithDemos(client, logsChannelId, {
      matchInfo: {
        matchType: "1v1", matchId, map: evt.map, server: reservation.serverKey || evt.server,
        winnerSteamId: evt.winner, duration: evt.duration, killGoal: evt.kill_goal,
        roundsWon: evt.rounds_won, roundsRequired: evt.rounds_required,
        player1: { discordId: p1Discord, steamId: p1Steam, score: winnerIsP1 ? evt.winner_score : evt.loser_score },
        player2: { discordId: p2Discord, steamId: p2Steam, score: winnerIsP1 ? evt.loser_score : evt.winner_score },
      },
      hampalyzer: { url: hampalyzerUrl }, tfcstats: { url: tfcstatsUrl }, zipPath: null,
    });
    manager.complete(match.serverIp, reservation);
    return { matchId, hampalyzerUrl, tfcstatsUrl };
  };
}

module.exports = { createCompletionHandler };
