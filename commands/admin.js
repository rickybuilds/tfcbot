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

    if (!isAdmin(message)) {
      return message.channel.send("❌ You don’t have permission to use this command.");
    }

    // 🏷️ parse args
    const matchId = (args.shift() || "").trim();
    const result  = (args.shift() || "").toLowerCase();
    const isAuto  = args.includes("--auto"); // 👈 detect autoRecap trigger

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

      // 👇 forward hydrated match object so modeElo sees ADL/rng_multiplier
      elo.applyTeamResult({
        matchId,
        blue,
        red,
        winner: result,
        createdAt: match.createdAt || Date.now(),
        match,
      });

              elo.db.prepare(`
          UPDATE matches
          SET
            winner=?,
            status='completed',
            processed_at=?,
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
        .setDescription(`**${matchId}** — Winner: **${result.toUpperCase()}**`)
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
      SELECT match_id, server_name, map_name
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
        matchInfo: { matchId, map: mapNow, winner: result.toUpperCase() },
        tfcstats: { url: tfcUrl },
        hampalyzer: { url: hampUrl },
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
    if (!matchId) return message.channel.send("Usage: `!delmatch <matchId>`");

    try {
      try { elo.unreportMatch(matchId); } catch {}
      elo.db.prepare("DELETE FROM matches WHERE match_id=?").run(String(matchId));
      elo.db.prepare("DELETE FROM rating_changes WHERE match_id=?").run(String(matchId));

      // 🧩 Disarm autoRecap if still tracking
      if (reg?.autoRecap) reg.autoRecap.disarmByMatchId(matchId);

      message.channel.send(`🗑️ Match \`${matchId}\` deleted + Elo reverted.`);
    } catch (e) {
      console.error("[!delmatch] failed:", e);
      message.channel.send("Failed to delete match.");
    }
  });
}

module.exports = { register };