// commands/admin.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { guardChannel, isAdmin } = require("../lib/guards");
const { BanStore } = require("../lib/banStore");
const banStore = new BanStore("bot.db");

/**
 * Try to load a match from memory or file store.
 */
function findMatchById(matchId, state, matchesStore) {
  if (typeof matchesStore?.findById === "function") {
    const m = matchesStore.findById(matchId);
    if (m) return m;
  }
  if (Array.isArray(state.matches)) {
    const m = state.matches.find(x => String(x.id) === String(matchId));
    if (m) return m;
  }
  if (typeof matchesStore?.getRecent === "function") {
    const m = matchesStore.getRecent(500).find(x => String(x.id) === String(matchId));
    if (m) return m;
  }
  return null;
}

function register(reg, deps) {
  const { config, state, elo, matchesStore } = deps;
  const ADMIN_CH  = String(config.channels.eloAdmin || "");
  const PICKUP_CH = String(config.channels.pickup || "");

  async function doReport(message, args = [], forceFix = false) {
    const chId = message.channel?.id;
    if (chId !== PICKUP_CH && chId !== ADMIN_CH) return;

    if (!message.internalAutoReport && !isAdmin(message)) {
      return message.channel.send("❌ You don’t have permission to use this command.");
    }

    // 🏷️ parse args
    const matchId = (args.shift() || "").trim();
    const result  = (args.shift() || "").toLowerCase();
    const isAuto  = args.includes("--auto"); // 👈 detect autoRecap trigger
    const scoreBlueArg = args.find(arg => arg.startsWith("--score-blue="));
    const scoreRedArg = args.find(arg => arg.startsWith("--score-red="));
    const scoreBlue = scoreBlueArg ? Number(scoreBlueArg.slice("--score-blue=".length)) : null;
    const scoreRed = scoreRedArg ? Number(scoreRedArg.slice("--score-red=".length)) : null;
    const hasAutoScores = isAuto &&
      Number.isInteger(scoreBlue) && scoreBlue >= 0 &&
      Number.isInteger(scoreRed) && scoreRed >= 0;

    if (!matchId || !["blue", "red", "tie"].includes(result)) {
      return message.channel.send("Usage: `!report <matchId> (blue|red|tie)`");
    }

    let match = findMatchById(matchId, state, matchesStore);

    // 🔥 Fallback: hydrate from DB if in-memory match missing fields
    if (match) {
      const row = elo.db.prepare(`
        SELECT mode, rng_multiplier, bonus_elo
        FROM matches
        WHERE match_id=?
      `).get(String(matchId));

      if (row) {
        match.mode = row.mode || "STANDARD";
        match.rng_multiplier = row.rng_multiplier || 1.0;
        match.bonusElo = row.bonus_elo ? JSON.parse(row.bonus_elo) : null;
      } else {
        match.mode = "STANDARD";
        match.rng_multiplier = 1.0;
        match.bonusElo = null;
      }
    }

    if (!match) return message.channel.send("Could not find that match.");

    console.log("[report] match data:", {
      mode: match.mode,
      rng: match.rng_multiplier,
      bonus: match.bonusElo,
      auto: isAuto,
    });

    const blue = (match.blueTeam || match.blue || []).map(p => ({ id: p.id, name: p.name }));
    const red  = (match.redTeam  || match.red  || []).map(p => ({ id: p.id, name: p.name }));
    if (!blue.length || !red.length) return message.channel.send("Match is missing team data.");

    try {
      try { elo.unreportMatch(matchId); } catch {}

      // Live Gentle must not write V1 first: NN performance arrives after the
      // match. Prepare the exact V1 team pools and defer the rating write.
      const eloArgs = {
        matchId,
        blue,
        red,
        winner: result,
        createdAt: match.createdAt || Date.now(),
        match,
      };
      const liveGentle = config.eloV2Mode === "live-gentle";
      let preparedLive = null;
      if (liveGentle) {
        preparedLive = elo.applyTeamResult(eloArgs, { dryRun: true });
        preparedLive.winner = result;
        preparedLive.blue = preparedLive.blue.map(player => ({ ...player, currentDelta: preparedLive.bluePool }));
        preparedLive.red = preparedLive.red.map(player => ({ ...player, currentDelta: preparedLive.redPool }));
      } else {
        // Existing V1 live behavior.
        elo.applyTeamResult(eloArgs);
      }

      elo.db.transaction(() => {
              elo.db.prepare(`
          UPDATE matches
          SET
            winner=?,
            status='completed',
            processed_at=CASE WHEN lower(status)='completed' AND processed_at IS NOT NULL THEN processed_at ELSE ? END,
            hampalyzer_url=COALESCE(NULLIF(hampalyzer_url, ''), NULLIF(?, '')),
            tfcstats_url=COALESCE(NULLIF(tfcstats_url, ''), NULLIF(?, ''))
          WHERE match_id=?
        `).run(
          result.toUpperCase(),
          Math.floor(Date.now()/1000),
          match.hampalyzer_url || match.hampalyzerUrl || match.hampalyzer || "",
          match.tfcstats_url || match.tfcstatsUrl || match.tfcstats || "",
          String(matchId)
        );
      })();
      // The official report commits independently. Prediction reconciliation
      // reads that row and must never interrupt normal reporting or Elo work.
      try {
        elo.db.transaction(() => deps.predictions?.onMatchReported({ matchId }))();
      } catch {
        console.warn("[predictions] result reconciliation deferred");
      }

      try {
        if (liveGentle) {
          const scheduled = deps.eloShadow?.scheduleLive(matchId, preparedLive, { delayMs: forceFix ? 1000 : undefined });
          if (!scheduled?.scheduled && !scheduled?.idempotent) throw new Error("live_gentle_not_scheduled");
        } else {
          // Shadow mode remains forward-only and never mutates live Elo.
          deps.eloShadow?.schedule(matchId, { force: forceFix });
        }
      } catch (shadowErr) {
        if (liveGentle) throw shadowErr;
        console.warn(`[elo-shadow] Could not schedule ${matchId}:`, shadowErr);
      }

      // decrement bans for match players
      for (const p of [...blue, ...red]) {
        const currentBan = banStore.getBan(p.id);
        if (currentBan) {
          const updated = banStore.decrementBan(p.id);
          if (!updated) console.log(`[ban expired] ${p.id} ban fully served`);
          else console.log(`[ban updated] ${p.id} now has ${updated.gamesRemaining} games left`);
        }
      }

      // decrement ghost bans
      if (state.ghostBans) {
        const ghostIds = Object.keys(state.ghostBans);
        for (const userId of ghostIds) {
          const currentBan = banStore.getBan(userId);
          if (currentBan) banStore.decrementBan(userId);
        }
        state.ghostBans = {};
      }

      // ✅ announce basic report
      const emb = new EmbedBuilder()
        .setColor(result === "tie" ? 0xfee75c : result === "blue" ? 0x57f287 : 0xed4245)
        .setTitle(forceFix ? "Match Result Corrected" : "Match Reported")
        .setDescription(
          `**${matchId}** — Winner: **${result.toUpperCase()}**` +
          (hasAutoScores ? `\n🔵 ${scoreBlue}     🔴 ${scoreRed}` : "")
        )
        .setTimestamp();
      await message.channel.send({ embeds: [emb] });

      // 🔓 unlock servers after completion
      try {
        const recap = state.autoRecap || reg.autoRecap;
        if (recap) {
          const row = elo.db.prepare("SELECT status FROM matches WHERE match_id=?").get(matchId);
          if (row && row.status === "completed") {
            recap.disarmByMatchId(matchId);
            console.log(`[!report] ✅ AutoRecap disarmed for completed match ${matchId}`);
          }
        }
      } catch (err) {
        console.warn(`[!report] ⚠️ Failed to auto-unlock for ${matchId}:`, err);
      }

// -----------------------------------------------------------------
// 📦 Silent recap upload (only if manually triggered)
// -----------------------------------------------------------------
if (!isAuto) {
  try {
    const { downloadAndUploadLogs } = require("../services/hldsTransfer");
    const { fetchAndZipRecentDemos, cleanupResult } = require("../services/hltvFetch");
    const { sendRecapWithDemos } = require("../services/discordUpload");
    const { determineServerKey } = require("../services/autoRecap");

    const dbMatch = elo.db.prepare(`
      SELECT match_id, server_name, map_name, score_blue, score_red
      FROM matches
      WHERE match_id = ?
    `).get(String(matchId));

    const mapNow = dbMatch?.map_name || match.map || match.map_name || "unknown";
    const serverInput = dbMatch?.server_name || match.server?.ip || match.server_name;

    if (!serverInput) {
      await message.channel.send(
        `❌ Cannot determine server for match **${matchId}**. No DB server_name found.`
      );
      return;
    }

    const serverKey = determineServerKey(serverInput);
    let replayRounds = [];
    try {
      replayRounds = elo.db.prepare(`
        SELECT round_number
        FROM pickup_replay_recordings
        WHERE match_id=? AND server_key=?
          AND observed_state='ready' AND stopped_at IS NOT NULL
        ORDER BY round_number
      `).all(String(matchId), serverKey)
        .map(row => Number(row.round_number))
        .filter(round => round === 1 || round === 2);
    } catch (replayErr) {
      console.warn(`[!report] Could not confirm replay availability for ${matchId}:`, replayErr.message);
    }
    console.log("[!report server resolution]", {
      matchId,
      dbServer: dbMatch?.server_name,
      memServer: match.server?.ip,
      matchServerName: match.server_name,
      serverInput,
      serverKey,
    });

    // 🟦 1️⃣ Fetch HLTV demos
    const zipResult = await fetchAndZipRecentDemos({
      mapName: mapNow,
      lookback: 12,
      requiredCount: 2,
      server: serverKey,
    }).catch(() => null);

    // 🟩 2️⃣ Remote SFTP: Download + Upload Logs
    const resultUpload = await downloadAndUploadLogs({
      matchId,
      map: mapNow,
      server: serverKey,
      extra: { winner: result },
    });

    const hampUrl = resultUpload.upload?.url;
    const tfcUrl  = resultUpload.tfcstats?.url;
	
	    elo.db.prepare(`
		  UPDATE matches
		  SET
			hampalyzer_url=COALESCE(NULLIF(hampalyzer_url, ''), NULLIF(?, '')),
			tfcstats_url=COALESCE(NULLIF(tfcstats_url, ''), NULLIF(?, ''))
		  WHERE match_id=?
		`).run(
		  hampUrl || "",
		  tfcUrl || "",
		  String(matchId)
		);

		console.log(`[!report] Saved Hampalyzer/TFCStats URLs for ${matchId}`, {
		  hampUrl,
		  tfcUrl,
		});

    // 🟧 3️⃣ Upload demos (silent, no chat posts)
    if (zipResult?.zipPath) {
      await sendRecapWithDemos(message.client, config.channels.logs, {
        zipPath: zipResult.zipPath,
        matchInfo: {
          matchId,
          map: mapNow,
          winner: result.toUpperCase(),
          server: serverKey,
          scoreBlue: dbMatch?.score_blue ?? match.scoreBlue ?? match.blueScore,
          scoreRed: dbMatch?.score_red ?? match.scoreRed ?? match.redScore,
        },
        tfcstats: { url: tfcUrl },
        hampalyzer: { url: hampUrl },
        replayRounds,
      });
      cleanupResult(zipResult);
    }

    console.log(`[!report silent recap] ✅ Logs & demos uploaded for ${matchId}`);
  } catch (uploadErr) {
    console.error("[!report silent recap failed]", uploadErr);
  }
} 

    } catch (e) {
      console.error("[!report] failed:", e);
      await message.channel.send("Could not report that match.");
    }
  } 

  // ⬇️ Now we register the commands cleanly ⬇️
  reg.set("report",    (msg, args) => doReport(msg, args, false));
  reg.set("fixreport", (msg, args) => doReport(msg, args, true));

reg.set("fixscores", async (message, args = []) => {
  if (!isAdmin(message)) {
    return message.channel.send("❌ You don’t have permission to use this command.");
  }

  const chId = message.channel?.id;
  if (chId !== PICKUP_CH && chId !== ADMIN_CH) return;

  const matchId = (args[0] || "").trim();
  const blueScore = Number.parseInt(args[1], 10);
  const redScore = Number.parseInt(args[2], 10);

  if (
    !matchId ||
    !Number.isInteger(blueScore) ||
    !Number.isInteger(redScore) ||
    blueScore < 0 ||
    redScore < 0
  ) {
    return message.channel.send("Usage: `!fixscores <matchId> <blueScore> <redScore>`");
  }

  try {
    const info = elo.db.prepare(`
      UPDATE matches
      SET score_blue=?, score_red=?
      WHERE match_id=?
    `).run(blueScore, redScore, String(matchId));

    if (!info.changes) {
      return message.channel.send(`❌ No match found for **${matchId}**.`);
    }

    return message.channel.send(
      `✅ Scores updated for **${matchId}**: Blue **${blueScore}** - Red **${redScore}**`
    );
  } catch (e) {
    console.error("[!fixscores] failed:", e);
    return message.channel.send("Failed to update scores.");
  }
});

  reg.set("delmatch", (message, args = []) => {
    if (!isAdmin(message)) {
      return message.channel.send("❌ You don’t have permission to use this command.");
    }
    const chId = message.channel?.id;
    if (chId !== PICKUP_CH && chId !== ADMIN_CH) return;

    const matchId = (args[0] || "").trim();
    if (!matchId) return message.channel.send("Usage: !delmatch <matchId> [reason]");
    const reason = args.slice(1).join(" ").trim() || "Admin requested match deletion";
    let failureStage = "database setup", committed = false;
    try {
      if (deps.predictions && deps.predictions.db !== elo.db) throw new Error("Prediction and Elo databases differ");
      const context = deps.predictions?.context("match-delete", String(message.author.id), reason);
      const result = elo.db.transaction(() => {
        require("../lib/matchDeletionAudit").initializeMatchDeletionAudit(elo.db);
        if (!elo.db.prepare("SELECT 1 FROM matches WHERE match_id=?").get(matchId)) return null;
        if (elo.db.prepare("SELECT 1 FROM match_deletion_audit WHERE match_id=?").get(matchId)) throw new Error("Match ID was already deleted");
        failureStage = "prediction cleanup";
        const markets = deps.predictions ? deps.predictions.store.markets().filter(m=>m.match_id===matchId).map(m=>({
          id:m.id, previousState:m.state, settlementVersion:m.settlement_version,
          retainedSettlement:m.settlement_version>0,
          refunds:m.settlement_version||m.state==="void"?[]:deps.predictions.store.bets(m.id).filter(b=>b.status==="active").map(b=>({betId:b.id,amount:b.stake}))
        })) : [];
        let eloOutcome;
        const deleteWrites = () => {
          failureStage = "Elo rollback or match removal";
          const count = elo.db.prepare("SELECT COUNT(*) AS n FROM rating_changes WHERE match_id=?").get(matchId).n;
          if(count){
            const later=elo.db.prepare("SELECT 1 FROM rating_changes original JOIN rating_changes newer ON newer.player_id=original.player_id AND newer.id>original.id WHERE original.match_id=? AND newer.match_id<>? LIMIT 1").get(matchId,matchId);
            if(later)throw new Error("Later Elo changes require a rating replay");
            const mismatch=elo.db.prepare("SELECT 1 FROM rating_changes c LEFT JOIN ratings r ON r.player_id=c.player_id WHERE c.match_id=? AND c.player_id IS NOT NULL AND (r.player_id IS NULL OR r.rating<>c.after) LIMIT 1").get(matchId);
            const duplicate=elo.db.prepare("SELECT 1 FROM rating_changes WHERE match_id=? AND player_id IS NOT NULL GROUP BY player_id HAVING COUNT(*)>1 LIMIT 1").get(matchId);
            if(mismatch||duplicate)throw new Error("Elo history requires review before rollback");
            const reverted=elo.unreportMatch(matchId);
            if(!reverted || reverted.revertedCount!==count || elo.db.prepare("SELECT 1 FROM rating_changes WHERE match_id=?").get(matchId))throw new Error("Elo rollback incomplete");
            eloOutcome={status:"reverted",revertedCount:reverted.revertedCount};
          } else eloOutcome={status:"no rating changes",revertedCount:0};
          if(elo.db.prepare("DELETE FROM matches WHERE match_id=?").run(matchId).changes!==1)throw new Error("Match deletion incomplete");
        };
        if(deps.predictions)deps.predictions.applyMatchDeletion({matchId,applyMatchWrites:deleteWrites,retainSettledHistory:true,context});
        else deleteWrites();
        failureStage = "audit recording";
        elo.db.prepare("INSERT INTO match_deletion_audit VALUES (?,?,?,?,?,?)").run(matchId,String(message.author.id),context?.now ?? Date.now(),reason,JSON.stringify(markets),JSON.stringify(eloOutcome));
        return {markets,eloOutcome};
      }).immediate();
      if(!result)return message.channel.send("❌ No match found for **"+matchId+"**.");
      committed=true;
      try { reg?.autoRecap?.disarmByMatchId(matchId); } catch (error) { console.error("[!delmatch] autoRecap disarm failed:",error); }
      const lines=["🗑️ Match "+matchId+" deleted.","",result.eloOutcome.revertedCount?"✅ Elo reverted":"✅ No Elo changes to revert","✅ Prediction markets processed"];
      if(result.markets.some(m=>m.refunds.length))lines.push("✅ Unresolved wagers refunded");
      if(result.markets.some(m=>m.retainedSettlement))lines.push("✅ Settled prediction history preserved");
      lines.push("✅ Audit history retained");
      return message.channel.send(lines.join("\n"));
    } catch (e) {
      console.error("[!delmatch] failed:", e);
      if(committed)return;
      const detail=e.message==="Later Elo changes require a rating replay"?" Later Elo changes require a rating replay before this match can be deleted.":e.message==="Elo history requires review before rollback"?" Elo history requires review before this match can be deleted.":" Check the bot logs for details.";
      return message.channel.send("Failed to delete match during " + failureStage + "; no changes were committed." + detail);
    }
  });
}

module.exports = { register };
