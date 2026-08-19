// services/autoRecap.js
"use strict";
const { fetchAndZipRecentDemos, cleanupResult } = require("./hltvFetch");
const { sendRecapWithDemos } = require("./discordUpload");
const { startVoiceBots, stopVoiceBots } = require("../services/voiceManager");
const fs = require("fs");
const path = require("path");
const { downloadAndUploadLogs } = require("./hldsTransfer");
const { runRconCommand } = require("./rconClient");
const { PickupReplayRecorder } = require("./pickupReplayRecorder");
const { postCleanFirstPickupClips } = require("./pickupReplayClips");
const config = require("../config");
const rconCfg = require("../config/rcon"); // 👈 NEW
const { state } = require("../lib/state"); 
const { loadMapCaptures } = require("../lib/mapCapturesStore");
const {
  calculateMatchScores,
  getTeamStartPlan,
  logicalTeamForPhysical,
  normalizeTeam1Starts,
} = require("../lib/teamStart");

const armed = new Map();

function getLiveStatePath(serverKey){return `/root/tfcbot/live_${serverKey}.json`;}

function writeLiveState(a) {
  try {

    const state = {
      active: true,
      match_id: a.matchId,
      map: a.map,
      round: Math.min((a.half || 0) + 1, 2),

      halfScores: a.halfScores || [],

      liveCaps: a.liveCaps || 0,
      currentScore: a.liveScore || 0,

      savedScore:
        (a.halfScores || []).reduce((sum, h) => {
          return sum + Number(h.blue || 0) + Number(h.red || 0);
        }, 0),

      lastCap: a.lastCap || null,
      events: a.liveEvents || [],

      updated_at: Math.floor(Date.now()/1000)
    };

    fs.writeFileSync(
      getLiveStatePath(a.serverKey),
      JSON.stringify(state,null,2)
    );

  } catch(err) {
    console.warn(
      "[live_state write failed]",
      err
    );
  }
}

function clearLiveState(serverKey) {
  try {
    fs.writeFileSync(
       getLiveStatePath(serverKey),
        JSON.stringify({
          active: false,
          match_id: null,
          map: null,
          round: null,
          halfScores: [],
          liveCaps: 0,
          currentScore: 0,
          savedScore: 0,

          lastCap: null,
          events: [],

          updated_at: Math.floor(Date.now() / 1000)
        }, null, 2)
    );
  } catch (err) {
    console.warn("[live_state clear failed]", err);
  }
}

function getCaptureRule(mapName, evt) {
  const triggerText = String(evt.trigger || evt.name || evt.raw || "").toLowerCase();
  const mapKey = normalize(mapName);

  const json = loadMapCaptures({
    onError: err => console.warn("[autoRecap] failed to load mapCaptures.json:", err.message),
  });

  const globalRules = json.global || [];

  const mapRules =
    json.maps?.[mapName] ||
    json.maps?.[mapKey] ||
    [];

  const rules = [...globalRules, ...mapRules];

  return rules.find(r =>
    triggerText.includes(String(r.trigger || "").toLowerCase())
  ) || null;
}
/* ----------------------------- helper functions ---------------------------- */

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function looseMapEqual(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function keyOf(serverRef) {
  if (!serverRef) return "east";
  const value = String(serverRef).trim().toLowerCase();
  if (rconCfg[value]) return value;
  return determineServerKey(serverRef) || `unresolved:${value}`;
}

function eventServerKey(evt) {
  if (evt?.serverKey) return String(evt.serverKey);
  // Synthetic/unit-test events without a source retain the historical default.
  // Real UDP events always have from/sourcePort and must carry a resolved key.
  if (!evt?.from && !evt?.sourcePort) return "east";
  return null;
}

/* --------------------------- resolve server --------------------------- */
function determineServerKey(serverRef) {
  if (!serverRef) return "east";

  const value = String(serverRef).trim().toLowerCase();
  if (rconCfg[value]) return value;
  const endpoint = value.match(/^(.+):(\d+)$/);
  const ipBase = endpoint ? endpoint[1] : value;
  const requestedPort = endpoint ? Number(endpoint[2]) : null;

  const matches = Object.entries(rconCfg).filter(([key, srv]) => {
    const hostBase = String(srv.host || "").split(":")[0].toLowerCase();
    const serverName = String(srv.name || "").trim().toLowerCase();

    if (serverName === value) return true;
    if (hostBase !== ipBase) return false;
    return requestedPort == null || Number(srv.port) === requestedPort;
  });

  if (matches.length === 1) return matches[0][0];
  console.warn(
    `[server resolve] ${matches.length ? "Ambiguous" : "Unknown"} server reference: ${serverRef}`
  );
  return null;
}

function attachAutoRecap(ctx, options = {}) {
  const { client } = ctx;
  const rconCommand = options.runRconCommand || runRconCommand;
  const voiceStart = options.startVoiceBots || startVoiceBots;
  const voiceStop = options.stopVoiceBots || stopVoiceBots;
  const recorder = options.recorder || new PickupReplayRecorder({
    db: ctx.matchesStore.db,
    runRconCommand: rconCommand,
    enabled: config.pickupRecordingEnabled,
  });
  const eventQueues = new Map();

  // ✅ Channel references pulled from config.js
  const recapChannel = config.channels.recap;
  const reportChannel = config.channels.pickup;
  const logsChannel = config.channels.logs;
  const clipsChannel = config.channels.clips;

  function getReadyReplayRounds(matchId, serverKey) {
    try {
      return ctx.matchesStore.db.prepare(`
        SELECT round_number
        FROM pickup_replay_recordings
        WHERE match_id=? AND server_key=?
          AND observed_state='ready' AND stopped_at IS NOT NULL
        ORDER BY round_number
      `).all(String(matchId), String(serverKey))
        .map(row => Number(row.round_number))
        .filter(round => round === 1 || round === 2);
    } catch (error) {
      console.warn(`[autoRecap] Could not confirm replay availability for ${matchId}:`, error.message);
      return [];
    }
  }

  function scheduleCleanClipScan({ matchId, serverKey, rounds }) {
    let attempt = 0;
    const scan = async () => {
      attempt += 1;
      try {
        const clips = await postCleanFirstPickupClips({
          client,
          channelId: clipsChannel,
          db: ctx.matchesStore.db,
          serverKey,
          matchId,
          rounds,
        });
        if (clips.length) {
          console.log(`[autoRecap] posted ${clips.length} clean pickup clip(s) for ${matchId}`);
          return;
        }
      } catch (clipError) {
        console.warn(`[autoRecap] clean pickup clip scan failed for ${matchId}:`, clipError.message);
      }
      // The central uploader runs independently of the bot. Give it a few
      // short opportunities to publish the finalized archive before giving up.
      if (attempt < 6) {
        const retry = setTimeout(() => { void scan(); }, 30_000);
        retry.unref?.();
      }
    };
    void scan();
  }

  const windowMin = Math.max(5, Number(options.windowMin || 45));
  const ttlMin = Math.max(10, Number(options.ttlMin || 90));
  const uploadEnabled = true;
  const minKb = Number(process.env.HL_MIN_LOG_KB || 80);
  

  async function post(channelId, content) {
    if (!channelId) return;
    let ch = client.channels.cache.get(channelId);
    if (!ch) {
      try {
        ch = await client.channels.fetch(channelId);
      } catch (e) {
        console.warn(`[autoRecap] failed to fetch channel ${channelId}`, e);
        return;
      }
    }
    console.log(`[autoRecap post] sending to channel ${channelId}:`, content);
    return ch.send(content);
  }

  function arm({
    matchId,
    map,
    serverIp,
    teams,
    team1Starts,
    team1StartsForced = false,
    team1StartsReason = null,
  }) {
    const serverKey = determineServerKey(serverIp);
    if (!serverKey || rconCfg[serverKey]?.trackingOnly) {
      throw new Error(`Cannot arm pickup AutoRecap for unresolved/tracking-only server ${serverIp || "unknown"}`);
    }
    const k = serverKey;

    const previous = armed.get(k);
    if (previous?.timeout) clearTimeout(previous.timeout);

    const ctx = {
      matchId,
      map,
      serverIp,
      serverKey,
      serverName: rconCfg[serverKey]?.name || serverKey,
      teams: teams || null,
      team1Starts: normalizeTeam1Starts(team1Starts),
      team1StartsForced: Boolean(team1StartsForced),
      team1StartsReason,
      t0: Date.now(),
      lastMapSeen: null,
      half: 0,
      halfScores: [],
      liveCaps: 0,
      liveScore: 0,
      lastCap: null,
      liveEvents: [],
      mapInterrupted: false,
      files: [],
      done: false,
      timeout: setTimeout(() => disarm(serverIp), ttlMin * 60 * 1000),
    };

    armed.set(k, ctx);

	post(
	  recapChannel,
	  `🟢 Armed **${matchId}** on ${serverKey.toUpperCase()} (${serverIp}) — ` +
	  `map ${map}, Team 1 starts ${ctx.team1Starts} (TTL ${ttlMin}m)`
	).catch?.(() => {});

  }

  async function setStartingOrderHostname(a) {
    const teamStartPlan = getTeamStartPlan(a.team1Starts);
    const label = a.serverKey?.toUpperCase() || "SERVER";
    await rconCommand(
      a.serverKey,
      `hostname "fun stuff ${label} - T1 ${a.team1Starts.toUpperCase()} / T2 ${teamStartPlan.team2Starts.toUpperCase()}"`
    );
  }

  async function updateTeam1Starts(value, targetMatchId = null) {
    const team1Starts = normalizeTeam1Starts(value);
    const candidates = [...armed.values()].filter(a =>
      !a.done &&
      (!targetMatchId || String(a.matchId) === String(targetMatchId))
    );

    if (!targetMatchId && candidates.length > 1) {
      return {
        updated: [],
        blocked: [],
        ambiguous: true,
        matchIds: candidates.map(a => String(a.matchId)),
      };
    }

    const updated = [];
    const blocked = [];

    for (const a of candidates) {
      if (a.team1StartsForced && team1Starts !== a.team1Starts) {
        blocked.push({
          matchId: String(a.matchId),
          reason: a.team1StartsReason || "the selected map forces the starting order",
        });
        continue;
      }
      if ((a.half || 0) > 0 || (a.liveCaps || 0) > 0) {
        blocked.push({
          matchId: String(a.matchId),
          reason: "Round 1 has already started scoring",
        });
        continue;
      }

      a.team1Starts = team1Starts;
      for (const match of state.matches || []) {
        if (String(match.id || match.matchId) === String(a.matchId)) {
          match.team1Starts = team1Starts;
        }
      }

      try {
        await setStartingOrderHostname(a);
      } catch (err) {
        console.warn("[autoRecap] Failed to update starting-order hostname:", err);
      }
      const teamStartPlan = getTeamStartPlan(team1Starts);
      await post(
        reportChannel,
        `🔄 **${a.matchId} starting order updated** — ` +
        `Team 1 joins **BLUE** and starts **${team1Starts.toUpperCase()}**; ` +
        `Team 2 joins **RED** and starts **${teamStartPlan.team2Starts.toUpperCase()}**.`
      ).catch?.(() => {});
      updated.push(String(a.matchId));
    }

    if (targetMatchId && candidates.length === 0) {
      blocked.push({
        matchId: String(targetMatchId),
        reason: "no armed match was found",
      });
    }

    return {
      updated,
      blocked,
      ambiguous: false,
      matchIds: candidates.map(a => String(a.matchId)),
    };
  }

// 🔓 Unlock server when match ends or TTL expires
function unlockServer(serverIp) {
  try {
    if (!serverIp) return;
    const identity = String(serverIp);
    let cleared = 0;

    // Locks are endpoint identities. Never clear another logical server that
    // happens to share the same host/IP.
    if (state?.lockedServers instanceof Set) {
      for (const val of [...state.lockedServers]) {
        if (String(val) === identity) {
          state.lockedServers.delete(val);
          cleared++;
        }
      }
    }

    // 🧹 Clean from unified map
    if (state?.locks?.servers && typeof state.locks.servers === "object") {
      for (const [key] of Object.entries(state.locks.servers)) {
        if (String(key) === identity) {
          delete state.locks.servers[key];
          cleared++;
        }
      }
    }

    console.log(`[serverLock] 🧹 Cleared ${cleared} server lock entries for ${serverIp}`);
  } catch (err) {
    console.warn("[autoRecap unlockServer] failed:", err);
  }
}

function unlockPlayersForMatch(matchId) {
  try {
    const { state } = require("../lib/state");

    if (!state?.lockedPlayers) {
      console.warn(`[playerLock] Cannot unlock ${matchId}: state.lockedPlayers missing`);
      return [];
    }

    const unlockedIds = [];

    for (const [pid, lockedMatch] of state.lockedPlayers.entries()) {
      if (String(lockedMatch) === String(matchId)) {
        state.lockedPlayers.delete(pid);
        unlockedIds.push(pid);
        console.log(`[playerLock] Unlocked ${pid} from match ${matchId}`);
      }
    }

    console.log(
      `[playerLock] ✅ Unlocked ${unlockedIds.length} players for match ${matchId}`
    );

    return unlockedIds;
  } catch (err) {
    console.warn("[unlockPlayersForMatch] failed:", err);
    return [];
  }
}

  function disarm(serverRef) {
    const k = keyOf(serverRef);
    const a = armed.get(k);
    if (a?.timeout) clearTimeout(a.timeout);
    armed.delete(k);
	unlockServer(a?.serverIp || serverRef);
    return a?.matchId ? unlockPlayersForMatch(a.matchId) : [];
  }

//added new 1/31/26
function updateArmedMap(matchId, newMap) {
  if (!matchId || !newMap) return false;

  let changed = 0;
  for (const [k, a] of armed.entries()) {
    if (String(a.matchId) === String(matchId)) {
      const old = a.map;
      a.map = newMap;
      a.lastMapSeen = null;
      changed++;

      post(
        recapChannel,
        `🧭 Map override for match **${matchId}**: **${old}** → **${newMap}**`
      ).catch(() => {});
    }
  }

  if (changed > 0) {
    console.log(`[autoRecap] updated armed map for match ${matchId} -> ${newMap} (${changed} entries)`);
    return true;
  }

  console.log(`[autoRecap] no armed entry found for match ${matchId} (map not updated)`);
  return false;
}
//end new add 1/31/26

  async function disarmByMatchId(matchId) {
  let count = 0;
  for (const [k, a] of armed.entries()) {
    if (a.matchId === matchId) {
      if (a.timeout) clearTimeout(a.timeout);
      armed.delete(k);
      clearLiveState(a.serverKey);
      count++;
      const reason = a.done ? "cleanup complete" : "manual delete";
	  post(recapChannel, `🛑 Disarmed match ${matchId} (${reason})`).catch?.(() => {});

  if (a.voiceArmed) {
    console.log(`[autoRecap] 🎤 Manual disarm — stopping voice bots for ${a.matchId}`);
    try {
      await voiceStop();
    } catch (err) {
      console.warn("[autoRecap] Failed to stop voice bots on manual disarm:", err);
    }
    a.voiceArmed = false;
  }    

      console.log(`[autoRecap] Disarmed matchId ${matchId} on ${k}`);

      try {
        unlockPlayersForMatch(matchId);

try {
  // Server locks are endpoint-scoped. Never fall back to a bare IP here:
  // pickup and SKILLS can intentionally share the same host.
  unlockServer(a?.serverIp || k);
} catch (err) {
  console.warn(`[autoRecap] unlock failed for ${matchId}:`, err);
}

      } catch (err) {
        console.warn(`[autoRecap] unlock failed for ${matchId}:`, err);
      }
    }
  }
  
  // 🔁 fallback if not found in armed memory
  if (count === 0) {
    console.log(`[autoRecap] No armed state found for matchId ${matchId} — fallback unlock triggered.`);
    try {
      unlockPlayersForMatch(matchId);
      unlockServer(matchId); // will just noop if it's not an IP
    } catch (err) {
      console.warn(`[autoRecap fallback unlock] failed for ${matchId}:`, err);
    }
  }
}

  async function handleEvent(evt) {
    const k = eventServerKey(evt);
    if (!k || rconCfg[k]?.trackingOnly) {
      console.warn(
        `[autoRecap] ignored HLDS event from unresolved/tracking-only source ` +
        `${evt?.from || "unknown"}:${evt?.sourcePort || "?"}`
      );
      return;
    }
    const a = armed.get(k);
    if (!a) return;

    if (a.serverKey !== k) {
      console.warn(`[autoRecap] ignored HLDS event for ${evt?.serverKey || "unknown"}; armed=${a.serverKey}`);
      return;
    }

  // TTL still disarms stuck matches, but never interferes with voice bots
  if (Date.now() - a.t0 > ttlMin * 60 * 1000) {
    post(recapChannel, `⚠️ TTL expired for match ${a.matchId}`).catch?.(() => {});
    disarm(a.serverKey);
    return;
  }

    if (evt.type === "map") {
      if (!looseMapEqual(evt.name, a.map)) {
        a.mapInterrupted = true;
        console.warn(
          `[autoRecap] unexpected map for ${a.matchId} on ${a.serverKey}: ` +
          `${evt.name} (expected ${a.map}); pickup state preserved`
        );
        return;
      }

      a.lastMapSeen = evt.name;
      a.mapStartTime = Date.now();
      a.mapInterrupted = false;

      a.liveCaps = 0;
      a.liveScore = 0;
      a.lastCap = null;
      a.liveEvents = [];
      writeLiveState(a);

      console.log(`[autoRecap] reset liveCaps for ${a.matchId} on ${evt.name}`);
      await post(recapChannel, `🗺️ Map: **${evt.name}**`).catch?.(() => {});

      const roundNumber = Math.min((a.half || 0) + 1, 2);
      try {
        // A map load creates a fresh AMXX plugin instance. Its durable bot row may
        // still say "recording" from the instance that was aborted by map_change,
        // so explicitly start again and let AMXX replace this round's artifacts.
        await recorder.start(a.serverKey, a.matchId, roundNumber, { restart: true });
      } catch (err) {
        console.error("[autoRecap] Pickup replay start failed; state remains authoritative:", err.message);
        await post(recapChannel, `🚨 Replay recorder failed to start for **${a.matchId}** round ${roundNumber}; live setup is paused.`).catch?.(() => {});
      }

      // 🎙️ Rule 1: arm voice bots when the correct match map loads
      if (!a.voiceArmed) {
		  try {
		    await setStartingOrderHostname(a);
		  } catch (err) {
		    console.warn("[autoRecap] Failed to set starting-order hostname:", err);
		  }

		  a.voiceArmed = true;

		  console.log(`[autoRecap] 🎧 Voice bots arming for match ${a.matchId}`);

		  try {
			await voiceStart();
		  } catch (err) {
			console.warn("[autoRecap] Failed to start voice bots:", err);
		  }
		}

      return;
    }

    if (evt.type === "logfile") {
      if (!a.files.includes(evt.file) && a.files.length < 8) {
        a.files.push(evt.file);
      }
      return;
    }

/* -------------------------------------------------------------------------- */
/* Added this on 5/27/26 */
/* -------------------------------------------------------------------------- */
    if (evt.type === "capture") {

  // ignore captures before actual map start
  if (!a.lastMapSeen || a.mapInterrupted) {
    console.log(
      `[autoRecap] ignoring prematch capture for ${a.matchId}`
    );
    return;
  }
    const mapNow = a.lastMapSeen || a.map;
    const rule = getCaptureRule(mapNow, evt);

    if (!rule) return;

	const capValue = Number(rule.capValue ?? 1);
	const scoreValue = Number(rule.scoreValue ?? 10);

a.liveCaps = (a.liveCaps || 0) + capValue;
a.liveScore = (a.liveScore || 0) + scoreValue;

const physicalCapTeam =
  rule.team === "Blue" || rule.team === "Red"
    ? rule.team
    : evt.team;
const logicalCapTeam = logicalTeamForPhysical(
  a.team1Starts,
  Math.min((a.half || 0) + 1, 2),
  physicalCapTeam
);
const capTeam = logicalCapTeam === "team1" ? "BLUE" : "RED";
const capTeamLabel = logicalCapTeam === "team1" ? "Team 1" : "Team 2";
const capPlayer = evt.player || "unknown";

  const capEvent = {
    type: "capture",
    capNumber: a.liveCaps,
    player: capPlayer,
    team: capTeam,
    teamLabel: capTeamLabel,
    scoreValue,
    round: Math.min((a.half || 0) + 1, 2),
    map: mapNow,
    match_id: a.matchId,
    text: `${capPlayer} capped for ${capTeamLabel}`,
    ts: Math.floor(Date.now() / 1000)
  };

  a.lastCap = capEvent;
  a.liveEvents = [capEvent, ...(a.liveEvents || [])].slice(0, 10);

  writeLiveState(a);

    await post(
      recapChannel,
      `🏁 Capture ${a.liveCaps} — ${capTeamLabel} (${physicalCapTeam || "unknown"} side, ${evt.player || "unknown"})`
    ).catch?.(() => {});

    return;
  }
/* -------------------------------------------------------------------------- */
/* until here*/
/* -------------------------------------------------------------------------- */

    if (evt.type === "score_pair") {
	  if (a.mapInterrupted) {
		console.warn(`[autoRecap] ignored score_pair while ${a.matchId} is on an unexpected map`);
		return;
	  }
	  const mapNow = a.lastMapSeen || a.map;
	  if (!looseMapEqual(mapNow, a.map)) {
		console.warn(`[autoRecap] ignored score_pair for unexpected map ${mapNow}; expected ${a.map}`);
		return;
	  }

	  const blue = Number(evt.blue);
	  const red = Number(evt.red);

		// 🧠 Skip invalid or corrupted score pairs
		if (isNaN(blue) || isNaN(red)) {
		  console.log(`[autoRecap] ignored invalid score_pair:`, evt);
		  return;
		}

		// 🕒 Time since the current expected pickup map started. This safeguard is
		// evaluated before the authoritative commit, so later replay/map work cannot
		// make an already-valid half become "too late".
		const elapsedMin = (Date.now() - (a.mapStartTime || a.t0)) / 60000;

		// 🧩 Skip Half 1 if it happens too soon after map start (warmup)
		if (a.half === 0 && elapsedMin < 15) {
		  if (blue === 0 && red === 0) {
			console.log(
			  `[autoRecap] ignored early 0–0 score_pair — only ${elapsedMin.toFixed(1)} min since map start`
			);
			return;
		  }
		}

      const completedRound = Math.min((a.half || 0) + 1, 2);
      if (
        a.lastAcceptedScorePair?.round === completedRound &&
        a.lastAcceptedScorePair.blue === blue &&
        a.lastAcceptedScorePair.red === red &&
        Date.now() - Number(a.lastAcceptedScorePair.at || 0) < 5000
      ) {
        return;
      }
      a.lastScorePair = { signature: `${blue}:${red}:${completedRound}`, at: Date.now() };

      // Commit the half before replay/RCON work. This is the authoritative
      // transition and is intentionally synchronous/idempotent in this queue.
	  a.half = completedRound;
	  a.lastAcceptedScorePair = { round: completedRound, blue, red, at: Date.now() };
	  a.halfScores.push({ blue, red });
	  a.liveCaps = 0;
	  a.liveScore = 0;
	  a.lastCap = null;
	  a.liveEvents = [];
	  writeLiveState(a);

	  if (completedRound === 1) {
		post(
		  recapChannel,
		  `⏱️ Half 1 saved — ${mapNow} (Match ${a.matchId}): 🔵 ${blue} / 🔴 ${red}`
		).catch?.(() => {});
	  }

	  try {
		await recorder.stop(a.serverKey, a.matchId, completedRound);
	  } catch (err) {
		console.error("[autoRecap] Pickup replay stop failed after state commit:", err.message);
		await post(recapChannel, `🚨 Replay recorder failed to stop for **${a.matchId}** round ${completedRound}; authoritative match state was retained.`).catch?.(() => {});
	  }

	  if (completedRound === 1) {
		try {
		  const label = a.serverKey.toUpperCase();
		  const round1OffenseTeam =
		    getTeamStartPlan(a.team1Starts).round1.offenseTeam === "team1"
		      ? "Team 1"
		      : "Team 2";
		  const round1OffenseScore =
		    round1OffenseTeam === "Team 1" ? blue : red;
		  await rconCommand(
		    a.serverKey,
		    `hostname "fun stuff ${label} - ${round1OffenseTeam} Round 1 Score - ${round1OffenseScore}"`
		  );
		  await rconCommand(a.serverKey, `amx_map ${mapNow}`);

		  post(recapChannel, `🔄 Restarting map **${mapNow}** for Half 2...`).catch?.(() => {});
		} catch (e) {
		  console.error("[autoRecap restartMap] failed after Half 1 commit:", e);
		  post(recapChannel, "⚠️ Failed to restart map for Half 2; Half 1 remains committed.").catch?.(() => {});
		}
		return;
	  }

	  if (completedRound === 2) {
		writeLiveState(a);
		const h1 = a.halfScores[0] || { blue: 0, red: 0 };
		const h2 = a.halfScores[1] || { blue: 0, red: 0 };

		const { totalBlue, totalRed } = calculateMatchScores(
		  h1,
		  h2,
		  a.team1Starts
		);
		const winner =
		  totalBlue > totalRed ? "blue" :
		  totalRed  > totalBlue ? "red"  : "tie";

		await post(
		  recapChannel,
		  `🧾 **Recorded Match** — ${mapNow}\n + ID: ${a.matchId}\n + 🔵 Blue ${totalBlue} | 🔴 Red ${totalRed} → **${winner.toUpperCase()}**`
		).catch?.(() => {});

const autoReportArgs = [
  a.matchId,
  winner,
  "--auto",
  `--score-blue=${totalBlue}`,
  `--score-red=${totalRed}`,
];
const autoReportText = `!report ${autoReportArgs.join(" ")}`;
console.log(`[autoRecap] Internal report: ${autoReportText}`);

try {
  const reportCommand = ctx.registry?.get?.("report");
  let reportChannelObject = client.channels.cache.get(reportChannel);
  if (!reportChannelObject) {
    reportChannelObject = await client.channels.fetch(reportChannel);
  }

  if (typeof reportCommand !== "function" || !reportChannelObject) {
    throw new Error("report command or report channel is unavailable");
  }

  await reportCommand(
    {
      client,
      channel: reportChannelObject,
      content: autoReportText,
      author: { bot: true, id: client.user?.id },
      internalAutoReport: true,
    },
    autoReportArgs.slice()
  );
} catch (reportErr) {
  console.error(`[autoRecap] Internal report failed for ${a.matchId}:`, reportErr);
}

// 🧩 ensure serverName always set, even if armed entry missing
const resolvedKey = a.serverKey;
const resolvedName = rconCfg[resolvedKey]?.name || resolvedKey.toUpperCase();
console.log(`[autoRecap] Building embed for ${a?.matchId} on ${resolvedKey.toUpperCase()} (${resolvedName})`);

// ----- begin: demo + logs upload helper (demos first) -----
try {
  // 🟦 1️⃣ Fetch demos first (so they’re captured before logs upload)
  await new Promise(r => setTimeout(r, 3000)); // short buffer to let HLTV close files

  let zipResult = null;
  const hltvServerKey = a.serverKey;
  try {
    zipResult = await fetchAndZipRecentDemos({
      mapName: mapNow,
      lookback: 12,
      requiredCount: 2,
	  server: hltvServerKey, 
    });
	console.log(`[autoRecap] Fetching HLTV demos for ${hltvServerKey.toUpperCase()}`);
    console.log("[autoRecap] HLTV demo zip:", zipResult?.zipPath);
  } catch (fetchErr) {
    console.warn("[autoRecap] HLTV demos fetch failed:", fetchErr?.message);
  }

  // 🟩 2️⃣ Upload logs (Hampalyzer + TFCStats)
  const logsDir = path.resolve(process.env.HL_REMOTE_LOG_DIR || "logs");
  const sortedFiles = a.files
    .slice(-8)
    .map(f => {
      const full = path.join(logsDir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      return { f, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime)
    .map(x => x.f);

  const twoLatest = sortedFiles.slice(-2);
    console.log("[autoRecap] uploading logs (new→old):", twoLatest);
  await new Promise(r => setTimeout(r, 4000)); // ⏳ wait 4s for logs to flush

  // ✅ NEW: detect which server to pull from
  const serverKey = a.serverKey;
  console.log(`[autoRecap] Uploading logs for ${a.matchId} on ${serverKey}`);
  console.log("[autoRecap -> discordUpload] Sending matchInfo:", {
  server: serverKey,
  map: mapNow,
  matchId: a.matchId,
});

  const result = await downloadAndUploadLogs({
    filenames: twoLatest,
    matchId: a.matchId,
    map: mapNow,
    minKb,
    extra: { winner, totalBlue, totalRed },
    server: serverKey, // ✅ added
  });


  const hampUrl = result.upload?.url;
  const tfcUrl  = result.tfcstats?.url;
  const replayRounds = getReadyReplayRounds(a.matchId, serverKey);

  if (config.pickupReplayAutoClips && clipsChannel && replayRounds.length) {
    scheduleCleanClipScan({ matchId: a.matchId, serverKey, rounds: replayRounds });
  }

  // 🧠 Update DB with log URLs + scores
  try {
    ctx.matchesStore.db
      .prepare(
        `UPDATE matches SET hampalyzer_url=?, tfcstats_url=?, score_blue=?, score_red=? WHERE match_id=?`
      )
      .run(
        result.upload?.url || null,
        result.tfcstats?.url || null,
        totalBlue,
        totalRed,
        a.matchId
      );
    console.log("[autoRecap] Saved URL + scores for", a.matchId);
  } catch (dbErr) {
    console.error("[autoRecap] Failed to save recap info:", dbErr);
  }

 
  // 🟧 4️⃣ Send embed + demos zip (if available)
if (zipResult && zipResult.zipPath && fs.existsSync(zipResult.zipPath)) {
  const stats = fs.statSync(zipResult.zipPath);
  const sizeBytes = stats.size || 0;
  const maxAttach = 50 * 1024 * 1024; // 50 MB Discord limit

  if (sizeBytes <= maxAttach) {
    // small delay to ensure file is closed properly
    await new Promise(r => setTimeout(r, 1000));

    // 🧩 Always send recap using the shared upload helper
await sendRecapWithDemos(client, logsChannel, {
  matchInfo: {
    map: mapNow,
    scoreBlue: totalBlue,
    scoreRed: totalRed,
    winner: winner.toUpperCase(),
    matchId: a.matchId,
    server: serverKey, // ✅ ensures it’s always passed
  },
  tfcstats: { url: tfcUrl || null },
  hampalyzer: { url: hampUrl || null },
  replayRounds,
  mentionRoles: null,
  zipPath: zipResult?.zipPath || null, // ✅ passes HLTV zip if available, else null
});

    // ✅ cleanup after sending
    setTimeout(() => {
      try { cleanupResult(zipResult); } catch (e) {}
    }, 5000);

    clearLiveState(a.serverKey);
    a.done = true;
    return; // skip default embed

  } else {
    console.log(`[autoRecap] demo zip too large: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
    try { cleanupResult(zipResult); } catch (e) {}
  }
} else {
  console.log("[autoRecap] No demos found or zip missing.");

  // ✅ Guarantee server name even for manual or fallback recaps
  const safeServer =
    serverKey ||
    a?.serverKey ||
    a?.serverName ||
    "east";

  console.log("[autoRecap -> discordUpload] Fallback matchInfo:", {
    server: safeServer,
    map: mapNow,
    matchId: a.matchId,
  });

  await sendRecapWithDemos(client, logsChannel, {
    matchInfo: {
      map: mapNow,
      scoreBlue: totalBlue,
      scoreRed: totalRed,
      winner: winner.toUpperCase(),
      matchId: a.matchId,
      server: safeServer, // ✅ always filled
    },
    tfcstats: { url: tfcUrl || null },
    hampalyzer: { url: hampUrl || null },
    replayRounds,
  });
}

} catch (err) {
  console.error("[autoRecap demos+logs attach] unexpected error:", err);
}
    // ----- end: demo + logs upload helper -----

    // 🎙️ Rule 6: match complete, disarm voice bots
		if (a.voiceArmed) {
		  console.log(`[autoRecap] 🎤 Voice bots disarming for match ${a.matchId}`);

		  await voiceStop();
		  a.voiceArmed = false;
		}

    try {
      const label = a.serverKey?.toUpperCase() || serverKey.toUpperCase();
      await rconCommand(serverKey, `hostname "fun stuff — ${label}"`);
    } catch (e) {
      console.error("[autoRecap resetHostname] failed:", e);
    }

    clearLiveState(a.serverKey);
    a.done = true;


// ⏳ small delay to let !report finish updating DB
setTimeout(() => {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(process.env.DB_PATH || "elo.db");
    const row = db.prepare("SELECT status FROM matches WHERE match_id=?").get(a.matchId);
    db.close();

    if (row && row.status === "completed") {
      console.log(`[autoRecap] confirmed DB completed for ${a.matchId}, unlocking now`);
    } else {
      console.log(`[autoRecap] ${a.matchId} still in progress in DB, unlocking after completed game`);
    }
  } catch (e) {
    console.warn("[autoRecap delayed unlock failed]", e);
  }

  const current = armed.get(a.serverKey);
  const unlockedIds =
    String(current?.matchId) === String(a.matchId)
       ? disarm(a.serverKey)
      : unlockPlayersForMatch(a.matchId);
  if (unlockedIds.length) {
    post(
      recapChannel,
      `🔓 Match complete. Player locks have been cleared — queue is open again.`
    ).catch?.(() => {});
  }
}, 5000);

	  }
	}

  }

  function onEvent(evt) {
    const key = eventServerKey(evt) || `unresolved:${evt?.from || "unknown"}:${evt?.sourcePort || "?"}`;
    const previous = eventQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => handleEvent(evt));
    eventQueues.set(key, current);
    current.finally(() => {
      if (eventQueues.get(key) === current) eventQueues.delete(key);
    }).catch(() => {});
    return current;
  }

  recorder.reconcileAll().catch(err => {
    console.error("[autoRecap] Pickup replay restart reconciliation failed:", err.message);
  });

     return {
    armFromMatchReady: ({
      matchId,
      map,
      serverIp,
      teams,
      team1Starts,
      team1StartsForced,
      team1StartsReason,
    }) =>
      arm({
        matchId,
        map,
        serverIp,
        teams,
        team1Starts,
        team1StartsForced,
        team1StartsReason,
      }),
    disarmByIp: ip => disarm(ip),
    disarmByMatchId,
      onEvent,
      reconcilePickupRecorder: () => recorder.reconcileAll(),
    updateArmedMap,
    updateTeam1Starts,
  };

}

module.exports = { attachAutoRecap, armed, determineServerKey };
