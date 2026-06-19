// commands/voteFlow.js
"use strict";

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");
const { guardChannel } = require("../lib/guards");
const { startVote } = require("../lib/vote");
const { randomInt } = require("crypto");
const { pickUniqueMaps, buildMapOptionsFromList, recentMapExclusions } = require("../lib/maps");
const { generateFairScenarios, buildTeamScenariosEmbed, summarizeSplit, getRating } = require("../lib/odds");
const {
  isRealDiscordId,
  mention,
  clearAnyTimer,
  disableAllButtons,
  mirvLabel,
  genMatchId,
  formatPlayerName,
} = require("../lib/util");
const { makeBalancedTeams } = require("../lib/balance");
const { postQueueBoard } = require("./queue");
const { refreshBotName } = require("../lib/botName");
const QUEUE_FILE=path.join(process.cwd(),"queue.json");

// HLDS auto-recap
const { autoArmFromMatchReady } = require("../lib/autoArm");

// ADL voting state
const adl = require("../lib/adl");

// rank helper for streak trigger
const { rankFromRating } = require("../lib/elo");
console.log("[VOTEFLOW] Loaded state file:", require.resolve("../lib/state"));

/* ------------------------- ADL map pool loader ------------------------- */
	function loadAdlPool(file = process.env.ADL_MAPPOOL_FILE || "./mappool_adl.json") {
	  try {
		const fp = path.resolve(process.cwd(), file);
		if (!fs.existsSync(fp)) return [];
		const raw = fs.readFileSync(fp, "utf8");
		const arr = JSON.parse(raw);
		return arr.map(m => ({
		  key: m.key || m.name || makeKey(m.name),
		  name: m.name,
		  mirv: m.mirv || 0,
		  tier: m.tier || 1,
		  author: m.author || ""
		}));
	  } catch (e) {
		console.error("[loadAdlPool] failed:", e);
		return [];
	  }
	}

/* --------------------------- streak bonus check --------------------------- */
const { WinStreakStore } = require("../lib/winstreak");

function eligibleStreakPlayers(players, elo) {
  const STREAK_TRIGGER_WINS = Number(process.env.STREAK_TRIGGER_WINS || 5);
  const STREAK_MIN_RANK = Number(process.env.STREAK_MIN_RANK || 7);
  const store = new WinStreakStore(); // reads from elo.db

  const eligible = [];

  for (const p of players) {
    const rating = elo.getRating(p.id, p.name, { createIfMissing: false });
    const rank = Number(rankFromRating(rating)) || 0;
    const streak = store.get(p.id);

    if (rank >= STREAK_MIN_RANK && streak >= STREAK_TRIGGER_WINS) {
      console.log(`[STREAK BONUS] ${p.name} rank=${rank} streak=${streak}`);
      eligible.push({ id: p.id, name: p.name, rank, streak });
    }
  }

  return eligible;
}


/* =============================== register =============================== */
	function register(registry, { config, state, elo, privacy, matchesStore, settings, streaks }) {
		if (!state.lockedServers) state.lockedServers = new Set();
		if (!state.lockedPlayers) state.lockedPlayers = new Map();
	 registry.set("fv", async (message) => {
	  console.log("[!fv] triggered by", message.author.tag);

	  const ADMIN_ROLE = config.roles.admin || "";
	  const isAdmin = ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);
	  console.log("[!fv] admin check =", isAdmin, "role:", ADMIN_ROLE);

	  // 🚫 Block non-admins before touching state.voteLock
	  if (!isAdmin) {
		return message.reply("⚠️ You don’t have permission to use `!fv`.");
	  }

	  // ✅ Only admins reach here
	  if (state.voteLock) {
		console.log("[!fv] ignored — voteLock already true");
		return message.channel.send("⚠️ A vote is already in progress or locked. Please wait for it to finish.");
	  }

	  state.voteLock = true;
	  console.log(`[!fv] voteLock set by ${message.author?.tag || message.author?.id}`);

	  // 🛑 Prevent duplicate !fv triggers
	  if (state.isVoteStarting) {
		return message.channel.send("⚠️ A vote is already being started, please wait...");
	  }
	  state.isVoteStarting = true;

    try {
      if (!(await guardChannel(message, config.channels.pickup))) return;

      const max = state.MAX_PLAYERS || 8;
      if ((state.queue.length || 0) < max) {
        return message.channel.send(`🚨 Not enough players added! Currently **${state.queue.length}/${max}**.`);
      }
      if (state.vote) return message.channel.send("A vote is already running.");
      if (!state.servers.length) return message.channel.send("❗ No servers loaded. Update `servers.json` then `!reloadservers`.");
      if (!state.maps.length) return message.channel.send("❗ No maps loaded. Update `mappool.txt` then `!reloadmaps`.");

	//new 10/7/2025
	// 👻 Remove ghost-banned players from this match
	const { BanStore } = require("../lib/banStore");
	const banStore = new BanStore("bot.db");

	const ghosted = {};
	for (const p of state.queue) {
	  const ban = banStore.getBan(p.id);
	  if (ban && ban.gamesRemaining > 0) {
		ghosted[p.id] = ban;
	  }
	}

	if (Object.keys(ghosted).length > 0) {
	  state.ghostBans = ghosted;
	  state.queue = state.queue.filter(p => !ghosted[p.id]);

	  console.log(`[fv] ghost-banned players filtered out: ${Object.keys(ghosted).join(", ")}`);
	}

      // Freeze first N players
      state.queueSnapshot = state.queue.slice(0, max).map(p => ({ ...p }));
      state.serverWinner = null;

      // ADL decision on the frozen set
      const frozenIds = state.queueSnapshot.map(p => p.id);
      const { useAdl } = adl.shouldUseAdl(state, frozenIds, process.env);
      const MODE = useAdl ? "ADL" : "STANDARD";
      state.currentMode = MODE;

      // flip nickname to "voting…"
      state.isVotingInProgress = true;
      try { await refreshBotName(message.client, state); } catch {}

      // Announce mode
      await message.channel.send(
        useAdl
		  ? "**ADL ACTIVATED** — ADL map pool with **Bonus Elo Enabled**."
		  : "Running **Standard** (insufficient ADL votes)."
      );

      const serverVoteDur = settings.getNumber("vote:server_duration", 10);
      const mapVoteDur = settings.getNumber("vote:map_duration", 10);


	// 🔒 Filter out any currently locked (in-progress) servers
	const availableServers = state.servers.filter(s => !state.lockedServers.has(s.ip));

	if (!availableServers.length) {
	  await message.channel.send("🚫 No available servers right now — all are in use!");
	  state.isVotingInProgress = false;
	  try { await refreshBotName(message.client, state); } catch {}
	  return;
	}

	const serverOptions = availableServers
	  .slice(0, config.MAX_BUTTONS)
	  .map((s, idx) => ({ id: String(idx + 1), name: s.name, ref: s }));


	console.log("[!fv] starting server vote…", serverOptions.length, "options");
	await startVote(state, message, {
	  title: "Server Vote",
	  duration: serverVoteDur,
	  kind: "server",
	  options: serverOptions,
	  showVoters: true, 
	  elo,
	  privacy,
	  onVote: async ({ eligible, voted, voteHandle }) => {
		console.log("[!fv] inside onVote server vote");
          try {
            const allVoted = eligible.every(uid => voted.has(uid));
            const timeLeft = Math.max(0, voteHandle.endsAt - Date.now());
            if (allVoted && timeLeft > 10_000) {
              voteHandle.endsAt = Date.now() + 10_000;
              voteHandle.notifyTimers.forEach(clearAnyTimer);
              voteHandle.notifyTimers = [];
              clearAnyTimer(voteHandle.endTimer);
              voteHandle.endTimer = setTimeout(() => {
                try { voteHandle.collector.stop("fast_forward"); } catch {}
              }, 10_000);
              const mentions = eligible.map(id => `<@${id}>`).join(" ");
              await message.channel.send(`✅ All players voted. Vote ending early in **10s**! ${mentions}`);
            }
          } catch (e) {
            console.error("[serverVote onVote shorten]", e);
          }
        },

        onFinish: async ({ winner, eligible, voted }) => {
			console.log("[DEBUG onFinish payload]", JSON.stringify({ winner, eligible, voted }, null, 2));
          const missing = eligible
            .filter(uid => isRealDiscordId(uid))
            .filter(uid => !voted.has(uid));

          if (missing.length > 0) {
            const kicked = new Set(missing.map(String));
            state.queue = state.queue.filter(p => !kicked.has(String(p.id)));
            state.queueSnapshot = null;
            state.serverWinner = null;
            state.isVotingInProgress = false;
            try { await refreshBotName(message.client, state); } catch {}
				// 🔴 Not all players voted — log and kick
				const kickedNames = missing.map(id => {
				const m = message.guild?.members?.cache?.get(id);
				return m?.displayName || `<@${id}>`;
				}).join(", ");
				await message.channel.send(`Not all players voted. Kicked: ${kickedNames}`);

				// 📝 Append kicked info to ./kicked.json
				try {
				  const kickedFile = path.join(process.cwd(), "kicked.json");
				  const now = new Date();
				  const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
				  const entry = { timestamp, names: kickedNames };

				  let arr = [];
				  if (fs.existsSync(kickedFile)) {
					try { arr = JSON.parse(fs.readFileSync(kickedFile, "utf8") || "[]"); }
					catch { arr = []; }
				  }

				  arr.push(entry);
				  fs.writeFileSync(kickedFile, JSON.stringify(arr, null, 2));
				  console.log(`[KICKED LOG] Added ${kickedNames} @ ${timestamp}`);
				} catch (err) {
				  console.error("[KICKED LOG] Failed to write kicked.json:", err);
				}
            return postQueueBoard(message.channel, state, elo, privacy);
          }

		const winnerRef = winner?.ref || null;
		state.serverWinner = winnerRef;

		if (!state.serverWinner || !state.serverWinner.name) {
		  console.error("[serverVote] Invalid winner object:", winner);
		  await message.channel.send("⚠️ Could not finalize match — winner data missing or invalid.");
		  state.isVotingInProgress = false;
		  state.vote = null;
		  return;
		}

		 /* ------------------ Map Voting ------------------ */

		const recentN = Number(config.MAP_RECENT_EXCLUDE || 7);

		const excludeRecent = new Set(
		  [...recentMapExclusions(matchesStore, recentN)]
			.map(x => x.toLowerCase())
		);

		const mapSrc =
		  (MODE === "ADL")
			? (loadAdlPool() || [])
			: state.maps;

		await runMapVoteRound({
		  message,
		  state,
		  title: "Map Vote",
		  mapSource: mapSrc.length ? mapSrc : state.maps,
		  excludeSet: excludeRecent,
		  carryName: null,
		  rerollCount: 0,
		  maxRerolls: Number(process.env.MAP_MAX_REROLLS || 2),
		  mapVoteDur,
		  maxSelectionsPerUser: config.mapMaxSelectionsPerUser,
		  elo,
		  privacy,

		  finalize: async (mapRef) => {

			if (!mapRef || !state.serverWinner) {
			  return message.channel.send(
				"⚠️ Could not finalize match."
			  );
			}

			await finalizeMatch(
			  message.channel,
			  registry,
			  settings,
			  state,
			  state.serverWinner,
			  mapRef,
			  elo,
			  privacy,
			  matchesStore,
			  config,
			  MODE,
			  streaks
			);

		  }
		});

				},
			  });
    } catch (err) {
      console.error("[!fv error]", err);
      await message.channel.send("❌ Something went wrong during the vote.");
    } finally {
      state.isVoteStarting = false;
      state.voteLock = false;
      console.log("[!fv] voteLock released");
    }

  });

registry.set("cancelvote", async (message) => {
  const ADMIN_ROLE = config.roles.admin || "";
  const isAdmin = ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);
  if (!isAdmin) {
    return;
  }
  return cancelVote(message, config, state, elo, privacy);
});

	/* --------------------------- manual !vote ping --------------------------- */
	registry.set("vote", async (message) => {
	  const ADMIN_ROLE = config.roles.admin || "";
	  const isAdmin = ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);

	  const h = state.vote;
	  if (!h) return message.channel.send("⚠️ There’s no active vote right now.");

	  try {
		const now = Date.now();
		const timeLeft = Math.max(0, Math.floor((h.endsAt - now) / 1000));
		const eligible = h.eligible || [];
		const voted = h.voted || new Set();

		const missing = eligible.filter(uid => !voted.has(uid));
		if (missing.length === 0)
		  return message.channel.send(`✅ Everyone has already voted (${timeLeft}s left).`);

		const mentions = missing.map(id => `<@${id}>`).join(" ");
		await message.channel.send(
		  `⏰️ **Vote Reminder** — ${timeLeft}s remaining!\n${mentions}`
		);
	  } catch (e) {
		console.error("[!vote reminder failed]", e);
		await message.channel.send("❌ Failed to send vote reminder.");
	  }
	});

registry.set("requeue", async (message) => {
  const ADMIN_ROLE = config.roles.admin || "";
  const isAdmin = ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);
  if (!isAdmin) {
    return;
  }
  return cancelVote(message, config, state, elo, privacy);
});

}

async function cancelVote(message, config, state, elo, privacy) {
  const h = state.vote;
  if (h) {
    try {
      h.cancelled = true;
      h.notifyTimers?.forEach(clearAnyTimer);
      clearAnyTimer(h.endTimer);
      clearAnyTimer(h.tickTimer);
      const disabled = disableAllButtons(h.message);
      await h.message.edit({ components: disabled }).catch(() => {});
      h.collector?.stop("cancelled");
    } catch {}
  }
  state.vote = null;
  if (Array.isArray(state.queueSnapshot)) state.queue = state.queueSnapshot.map(p => ({ ...p }));
  state.queueSnapshot = null;
  state.serverWinner = null;

  state.isVotingInProgress = false;
  try { await refreshBotName(message.client, state); } catch {}

  await postQueueBoard(message.channel, state, elo, privacy);
}

async function cancelVoteAndRequeue(message, config, state, elo, privacy, leaverId) {
  // ✅ Ensure player is actually in the queue before doing anything
  const original = state.queueSnapshot || state.queue || [];
  const isInQueue = original.some(p => String(p.id) === String(leaverId));

  if (!isInQueue) {
    console.log(`[VOTE] Ignored leave — ${leaverId} was not in queue`);
    return; // 👈 do nothing if they weren’t in the match
  }

  const h = state.vote;
  if (h) {
    try {
      h.cancelled = true;
      h.notifyTimers?.forEach(clearAnyTimer);
      clearAnyTimer(h.endTimer);
      clearAnyTimer(h.tickTimer);
      const disabled = disableAllButtons(h.message);
      await h.message.edit({ components: disabled }).catch(() => {});
      h.collector?.stop("cancelled");
    } catch (e) {
      console.error("[cancelVoteAndRequeue] cleanup failed:", e);
    }
  }

  // build new queue excluding the leaver
  const leaverSet = new Set([String(leaverId)]);
  const requeue = original.filter(p => !leaverSet.has(String(p.id)));
  state.queueSnapshot = null;
  state.serverWinner = null;
  state.isVotingInProgress = false;

  try { await refreshBotName(message.client, state); } catch {}

  await message.channel.send(
    `⚠️ Player <@${leaverId}> left during vote. Vote canceled — requeuing remaining **${requeue.length}** players.`
  );

  await postQueueBoard(message.channel, state, elo, privacy);
}

	async function runMapVoteRound({ message, state, title, mapSource, excludeSet, carryName, rerollCount, maxRerolls, mapVoteDur, maxSelectionsPerUser, elo, privacy, finalize }) {
	  const roundList = require("../lib/maps").pickTieredMapsWithCounts(mapSource, excludeSet, carryName);
	  const options = buildMapOptionsFromList(roundList, rerollCount < maxRerolls);

return startVote(state, message, {
  title,
  duration: mapVoteDur,
  kind: "map",
  options,
  showVoters: true,
  maxSelectionsPerUser,
  elo,
  privacy,

  onVote: async ({ eligible, voted, voteHandle }) => {
    try {
      const realEligible = eligible.filter(uid => isRealDiscordId(uid));
      const allVoted = realEligible.every(uid => voted.has(uid));
      const timeLeft = Math.max(0, voteHandle.endsAt - Date.now());

      if (allVoted && timeLeft > 10_000) {
        voteHandle.endsAt = Date.now() + 10_000;

        voteHandle.notifyTimers?.forEach(clearAnyTimer);
        voteHandle.notifyTimers = [];

        clearAnyTimer(voteHandle.endTimer);

        voteHandle.endTimer = setTimeout(() => {
          try {
            voteHandle.collector.stop("fast_forward");
          } catch {}
        }, 10_000);

        const mentions =
          realEligible.map(id => `<@${id}>`).join(" ");

        await message.channel.send(
          `✅ All players voted. Vote ending early in **10s**! ${mentions}`
        );
      }
    } catch (e) {
      console.error("[mapVote onVote shorten]", e);
    }
  },

  onFinish: async ({ winner, counts, options }) => {
		  if (winner?.id === "N" || /new\s*maps?/i.test(winner?.name || "")) {
			const threshold = Number(process.env.MAP_REROLL_THRESHOLD || 6);
			const newOpt = options.find(o =>
				  o.id === winner?.id || /new\s*maps?/i.test(o.name || "")
				);
				const newVotes = counts.get(newOpt?.id) || 0;
			let topCount = 0;
			let topChoices = [];

			for (const opt of options) {
			  if (opt.id === "N") continue;

			  const c = counts.get(opt.id) || 0;

			  if (c > topCount) {
				topCount = c;
				topChoices = [opt];
			  } else if (c === topCount && c > 0) {
				topChoices.push(opt);
			  }
			}

			const top = topChoices.length
			  ? topChoices[randomInt(0, topChoices.length)]
			  : null;

			if (topChoices.length > 1) {
			  console.log(
				`[mapVote] Carry-over tie (${topCount} votes): ${topChoices.map(o => o.ref?.name || o.name).join(", ")} → picked ${top?.ref?.name || top?.name}`
			  );
			}

			const nextRerollCount = newVotes >= threshold ? rerollCount + 1 : maxRerolls;

			const used = new Set([
			  ...excludeSet,
			  ...options.filter(o => o.ref?.name).map(o => o.ref.name.toLowerCase())
			]);

			if (top?.ref?.name) used.delete(top.ref.name.toLowerCase());

			return runMapVoteRound({
			  message,
			  state,
			  title: `Map Vote (Reroll ${rerollCount + 1})`,
			  mapSource,
			  excludeSet: used,
			  carryName: top?.ref?.name || null,
			  rerollCount: nextRerollCount,
			  maxRerolls,
			  mapVoteDur,
			  maxSelectionsPerUser,
			  elo,
			  privacy,
			  finalize
			});
		  }

		  const mapRef = options.find(o => o.id === winner?.id)?.ref;
		  return finalize(mapRef);
		}
	  });
	}
/* Save queue File */
	function saveQueueFile(queue){
	  try{
		fs.writeFileSync(QUEUE_FILE,JSON.stringify(queue||[],null,2));
	  }catch(e){
		console.error("[queue] failed to write queue.json:",e);
	  }
	}

/* ---------------------------- finalizeMatch ---------------------------- */
async function finalizeMatch(
  channel, registry, settings, state,
  serverObj, mapObj, elo, privacy, matchesStore, config,
  MODE, streaks, 
  forceMatchId = null   // 👈 new arg
) {
  const players =
    Array.isArray(state.queueSnapshot) && state.queueSnapshot.length
      ? state.queueSnapshot
      : state.queue.slice(0, state.MAX_PLAYERS || 8);

  // Balance teams (actual teams used in match)
  const bal = makeBalancedTeams(players, elo);

  const blueList = bal.blue.length
    ? bal.blue.map(p => formatPlayerName(state, elo, p.id, p.name, privacy, true) || mention(p.id)).join("\n")
    : "_none_";
  const redList = bal.red.length
    ? bal.red.map(p => formatPlayerName(state, elo, p.id, p.name, privacy, true) || mention(p.id)).join("\n")
    : "_none_";

  const matchId = forceMatchId || genMatchId();

	// 🔥 Streak bonus (live from elo.db)
	let bonus = null;
	try {
	  const elig = eligibleStreakPlayers([...bal.blue, ...bal.red], elo);
	  if (elig.length > 0) {
		const mult = Math.floor(Math.random() * 4) + 2; // 2..5x
		bonus = {
		  multiplier: mult,
		  type: "WINNER_ONLY",
		  triggeredBy: elig.map(e => `${e.name} (${e.streak} wins)`),
		};
	  }
	} catch (err) {
	  console.error("[Streak bonus check failed]", err);
	}

  // 👉 Force ADL = 3× Elo
	if (MODE === "ADL") {
	  bonus = { multiplier: 3, type: "WINNER_ONLY", triggeredBy: ["ADL Mode"] };
	}

	// Build "Match Ready" embed
	  const emb = new EmbedBuilder()
		.setColor(0x57f287)
		.setTitle(`Match Ready — ${serverObj?.name || "Unknown Server"} — ${mapObj?.name || "Unknown Map"}`)
		.setURL(serverObj?.url || null)
		.setDescription(
		  `**Match ID:** ${matchId}\n` +
		  `Server: **${serverObj?.name || "Unknown Server"}**\n` +
		  `IP: **${serverObj?.ip || "?"}**\n` +
		  (serverObj?.password ? `Password: **${serverObj.password}**\n` : "") +
		  (serverObj?.url ? `[Click here to join server](${serverObj.url})\n` : "") +
		  `Map: **${mapObj?.name || "Unknown Map"}** (${mirvLabel(mapObj?.mirv)})\n` +
		  `Mode: **${MODE}**`
		)
		.addFields(
		  { name: "Blue Team 🔵", value: blueList, inline: true },
		  { name: "Red Team 🔴",  value: redList,  inline: true }
		)
		.setTimestamp();

    await channel.send({ embeds: [emb] });

  if (bonus) {
    let reason = bonus.triggeredBy?.includes("ADL Mode") ? "ADL Mode"
                : bonus.type === "WINNER_ONLY" ? "streak"
                : "special rule";

    await channel.send({
	  content:
		`🔥 **BONUS ELO ENABLED** (triggered by ${reason})\n` +
		`👀 Bonus Elo is active. Winner gains are capped at **+35 Elo**.`
	});
  }

	// 🔒 Lock server
	if (state.lockedServers) {
	  state.lockedServers.add(serverObj.ip);
	  console.log(`[serverLock] Locked server ${serverObj.ip} for match ${matchId}`);
	}
	await channel.send(`🔒 **${serverObj.name}** is now locked until the match completes.`);

	// 🔒 Lock all players in this match (store matchId for traceability)
	if (state.lockedPlayers) {
	  const allPlayers = [...bal.blue, ...bal.red];
	  for (const p of allPlayers) {
		state.lockedPlayers.set(String(p.id), matchId);
	  }
	  console.log(`[playerLock] Locked ${allPlayers.length} players for match ${matchId}`);
	}

  // 🟢 NEW: Arm autoRecap
  try {
	autoArmFromMatchReady({
  matchId,
  server: serverObj,
  map: mapObj,
  ttlMin: 90,
  teams: {
    blue: bal.blue.map(p => p.id), // Discord IDs
    red:  bal.red.map(p => p.id),
  }
});

  } catch (e) {
    console.error("[finalizeMatch] autoArmFromMatchReady failed:", e);
  }

  // Post scenarios (force Scenario 1 = actual teams)
  try {
    const chanId = String(config.channels.odds || "").trim();
    const oddsChan = chanId ? await channel.client.channels.fetch(chanId) : null;

    if (chanId && oddsChan?.isTextBased()) {
      const perms = oddsChan.permissionsFor(channel.client.user.id);
      const need = ["ViewChannel", "SendMessages", "EmbedLinks"];

      if (perms && need.every(p => perms.has(p))) {
        const ratings = new Map([...bal.blue, ...bal.red].map(p => [p.id, getRating(elo, p)]));
        const scenarios = [];

        // Scenario 1: actual teams
        scenarios.push({
          blue: bal.blue,
          red: bal.red,
          ...summarizeSplit(bal.blue, bal.red, ratings),
          score: Math.abs(bal.avgBlue - bal.avgRed),
        });

        // Add 3 alternative scenarios
        const extras = generateFairScenarios(players, elo, 4);
        for (const s of extras) {
          const key = s.blue.map(p => p.id).sort().join("|");
          const baseKey = scenarios[0].blue.map(p => p.id).sort().join("|");
          if (key !== baseKey) scenarios.push(s);
        }

        const scenEmb = buildTeamScenariosEmbed({
          matchId,
          serverName: serverObj?.name,
          ip: serverObj?.ip,
          mapName: mapObj?.name,
          scenarios,
          kFactor: Number(process.env.ELO_K || 32),
          elo,
          match: null,
        });

        await oddsChan.send({ embeds: [scenEmb] });
      }
    }
  } catch (e) {
    console.error("[odds] failed to post scenarios:", e);
  }

  // DB insert
	try {
	  elo.db.prepare(`
	  INSERT INTO matches (
		match_id, created_at, map_name, server_name,
		mode, avg_blue, avg_red, rng_multiplier, bonus_elo,
		blue_ids, red_ids, status
	  )
	  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress')
	  ON CONFLICT(match_id) DO UPDATE SET
		map_name=excluded.map_name,
		server_name=excluded.server_name,
		mode=excluded.mode,
		avg_blue=excluded.avg_blue,
		avg_red=excluded.avg_red,
		rng_multiplier=excluded.rng_multiplier,
		bonus_elo=excluded.bonus_elo,
		blue_ids=excluded.blue_ids,
		red_ids=excluded.red_ids,
		status='in_progress'
	`).run(
	  matchId,
	  Math.floor(Date.now() / 1000),
	  mapObj?.name || "(unknown)",
	  serverObj?.name || "(unknown)",
	  MODE || "STANDARD",
	  bal.avgBlue,
	  bal.avgRed,
	  bonus?.multiplier || 1.0,
	  bonus ? JSON.stringify(bonus) : null,

	  // 👉 Save full objects instead of just IDs
	  JSON.stringify(bal.blue.map(p => p.id)), // only IDs
	  JSON.stringify(bal.red.map(p => p.id))   // only IDs
	);
} catch (e) {
  console.error("[finalizeMatch] DB insert failed:", e);
}

  // Record object for in-memory + file store
const record = {
  id: matchId,
  createdAt: Date.now(),
  server: { name: serverObj?.name, ip: serverObj?.ip, password: serverObj?.password || "" },
  map: mapObj?.name,
  blueTeam: bal.blue.map(p => ({ id: p.id, name: p.name })),
  redTeam : bal.red.map(p => ({ id: p.id, name: p.name })),
  avgBlue: bal.avgBlue,
  avgRed : bal.avgRed,
  mode: MODE || "STANDARD",          // 👈 ensure mode is saved
  rng_multiplier: bonus?.multiplier || 1.0, // 👈 save rng multiplier (or 1.0 if none)
  bonusElo: bonus || null,
  reported: false,
  status: "in_progress"
};

	const idx = state.matches.findIndex(m => String(m.id) === String(matchId));
	if (idx !== -1) {
	  state.matches[idx] = record;   // overwrite existing
	} else {
	  state.matches.push(record);    // new match, normal flow
	}

  state.queue = [];
  saveQueueFile(state.queue);
  state.queueSnapshot = null;
  state.serverWinner = null;
  state.isVotingInProgress = false;

  // 👇 Reset ADL votes so they don't carry over
  try { 
    const adl = require("../lib/adl");
    adl.clearAll();
  } catch (e) {
    console.error("[finalizeMatch] Failed to clear ADL votes:", e);
  }

  try { await refreshBotName(channel.client, state); } catch {}

}

module.exports = { register, finalizeMatch, cancelVoteAndRequeue };
