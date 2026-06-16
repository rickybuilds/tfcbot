// services/autoRecap.js
"use strict";
const { fetchAndZipRecentDemos, cleanupResult } = require("./hltvFetch");
const { sendRecapWithDemos } = require("./discordUpload");
const { startVoiceBots, stopVoiceBots } = require("../services/voiceManager");
const fs = require("fs");
const path = require("path");
const { downloadAndUploadLogs } = require("./hldsTransfer");
const { runRconCommand } = require("./rconClient");
const config = require("../config");
const rconCfg = require("../config/rcon"); // 👈 NEW
const { state } = require("../lib/state"); 

console.log("[AUTORECAP] Loaded state file:", require.resolve("../lib/state"));
console.log("[AUTORECAP queueCheck] state.locks.servers =", state.locks?.servers);
console.log("[AUTORECAP queueCheck] state.lockedServers =", state.lockedServers);
console.log("[AUTORECAP queueCheck] autoRecap.locks =", state.autoRecap?.state?.locks?.servers);

const armed = new Map();

const mapCapturesPath = path.resolve(__dirname, "..", "mapCaptures.json");

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

function loadMapCaptures() {
  try {
    if (!fs.existsSync(mapCapturesPath)) return {};
    return JSON.parse(fs.readFileSync(mapCapturesPath, "utf8"));
  } catch (err) {
    console.warn("[autoRecap] failed to load mapCaptures.json:", err.message);
    return {};
  }
}

function getCaptureRule(mapName, evt) {
  const triggerText = String(evt.trigger || evt.name || evt.raw || "").toLowerCase();
  const mapKey = normalize(mapName);

  const json = loadMapCaptures();

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

// ✅ Always strip ports so HLDS events + arm() match
function keyOf(ip) {
  if (!ip) return "default";
  return String(ip).split(":")[0];
}

/* --------------------------- resolve server --------------------------- */
function determineServerKey(serverIp) {
  if (!serverIp) return "east";
  const ipBase = String(serverIp).split(":")[0];
  for (const [key, srv] of Object.entries(rconCfg)) {
    const hostBase = String(srv.host || "").split(":")[0];
if (hostBase === ipBase) return key;

  }
  return "east"; // fallback
}

function attachAutoRecap(ctx, options = {}) {
  const { client } = ctx;

  // ✅ Channel references pulled from config.js
  const recapChannel = config.channels.recap;
  const reportChannel = config.channels.pickup;
  const logsChannel = config.channels.logs;

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
    console.log(`[DEBUG post] sending to channel ${channelId}:`, content);
    return ch.send(content);
  }

  function arm({ matchId, map, serverIp, teams }) {
    const serverKey = determineServerKey(serverIp);
const k = keyOf(serverIp);

    //disarm(serverIp);

    const ctx = {
      matchId,
      map,
      serverIp,
      serverKey,
      serverName: rconCfg[serverKey]?.name || serverKey,
      teams: teams || null,
      t0: Date.now(),
      lastMapSeen: null,
      half: 0,
      halfScores: [],
      liveCaps: 0,
      liveScore: 0,
      lastCap: null,
      liveEvents: [],
      files: [],
      done: false,
      timeout: setTimeout(() => disarm(serverIp), ttlMin * 60 * 1000),
    };

    armed.set(k, ctx);

	post(
	  recapChannel,
	  `🟢 Armed **${matchId}** on ${serverKey.toUpperCase()} (${serverIp}) — map ${map} (TTL ${ttlMin}m)`
	).catch?.(() => {});

  }

// 🔓 Unlock server when match ends or TTL expires
function unlockServer(serverIp) {
  try {
    if (!serverIp) return;
    const ipOnly = String(serverIp).split(":")[0];
    let cleared = 0;

    // 🧹 Clean from Set (supports full and stripped forms)
    if (state?.lockedServers instanceof Set) {
      for (const val of [...state.lockedServers]) {
        if (val === serverIp || val === ipOnly || val.startsWith(ipOnly)) {
          state.lockedServers.delete(val);
          cleared++;
        }
      }
    }

    // 🧹 Clean from unified map
    if (state?.locks?.servers && typeof state.locks.servers === "object") {
      for (const [key, lock] of Object.entries(state.locks.servers)) {
        if (key === serverIp || key === ipOnly || key.startsWith(ipOnly)) {
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



// 🔓 Unlock all players tied to a match (with in-memory fallback)
function unlockPlayersForMatch(matchId) {
  try {
    const { state } = require("../lib/state");
    if (!state?.lockedPlayers) return;

    const dbPath = path.resolve(process.env.DB_PATH || "elo.db");
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);

    const row = db.prepare("SELECT blue_ids, red_ids FROM matches WHERE match_id=?").get(matchId);
    db.close();

    let allPlayers = [];
    if (row) {
      try {
        const blue = JSON.parse(row.blue_ids || "[]");
        const red  = JSON.parse(row.red_ids  || "[]");
        allPlayers = [...blue, ...red];
        console.log(`[playerLock] Unlocking ${allPlayers.length} players from DB for match ${matchId}`);
      } catch (err) {
        console.warn("[playerLock] Failed to parse player arrays:", err);
      }
    }

    // 🔁 fallback: use in-memory state if DB was empty
    if (!row || allPlayers.length === 0) {
      console.log(`[playerLock] No DB row found for match ${matchId}, using fallback unlock from state.`);
      for (const [pid, lockedMatch] of state.lockedPlayers.entries()) {
        if (lockedMatch === matchId) allPlayers.push(pid);
      }
    }

    if (allPlayers.length === 0) {
      console.log(`[playerLock] No players found to unlock for ${matchId}`);
      return;
    }

    for (const pid of allPlayers) {
      state.lockedPlayers.delete(String(pid));
      console.log(`[playerLock] Unlocked ${pid} from match ${matchId}`);
    }

    console.log(`[playerLock] ✅ Unlocked all players for match ${matchId}`);
  } catch (err) {
    console.warn("[unlockPlayersForMatch] failed:", err);
  }
}


  function disarm(serverIp) {
    const k = keyOf(serverIp);
    const a = armed.get(k);
    if (a?.timeout) clearTimeout(a.timeout);
    armed.delete(k);
	unlockServer(serverIp);
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
      await stopVoiceBots();
    } catch (err) {
      console.warn("[autoRecap] Failed to stop voice bots on manual disarm:", err);
    }
    a.voiceArmed = false;
  }    

      console.log(`[autoRecap] Disarmed matchId ${matchId} on ${k}`);

      try {
        unlockPlayersForMatch(matchId);

// 🧩 Try both IP and IP:PORT keys
try {
  const armedEntry = a?.serverIp || k;
  unlockServer(armedEntry); // full ip:port
  unlockServer(String(armedEntry).split(":")[0]); // plain ip fallback
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

  async function onEvent(evt) {
    const k = keyOf(evt.from);
    const a = armed.get(k);
    if (!a) return;

  // TTL still disarms stuck matches, but never interferes with voice bots
  if (Date.now() - a.t0 > ttlMin * 60 * 1000) {
    post(recapChannel, `⚠️ TTL expired for match ${a.matchId}`).catch?.(() => {});
    disarm(evt.from);
    return;
  }

    if (evt.type === "map") {
      a.lastMapSeen = evt.name;
      a.mapStartTime = Date.now();

      a.liveCaps = 0;
      a.liveScore = 0;
      a.lastCap = null;
      a.liveEvents = [];
      writeLiveState(a);

      console.log(`[autoRecap] reset liveCaps for ${a.matchId} on ${evt.name}`);
      await post(recapChannel, `🗺️ Map: **${evt.name}**`).catch?.(() => {});

      // 🎙️ Rule 1: arm voice bots when the correct match map loads
		if (!a.voiceArmed && looseMapEqual(evt.name, a.map)) {
		  a.voiceArmed = true;

		  console.log(`[autoRecap] 🎧 Voice bots arming for match ${a.matchId}`);

		  // 🔑 CRITICAL: tell spectator bot which matchId to use
		  try {
			const { setCurrentMatchId } = require("./hldsLogs");
			if (typeof setCurrentMatchId === "function") {
			  setCurrentMatchId(a.matchId);
			  console.log(`[autoRecap] → Told spectator bot to use matchId ${a.matchId}`);
			}
		  } catch (err) {
			console.warn("[autoRecap] Could not setCurrentMatchId:", err);
		  }

		  try {
			await startVoiceBots();
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
  if (!a.lastMapSeen) {
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

const capTeam = rule.team === "Blue" ? "BLUE" : "RED";
const capTeamLabel = rule.team === "Blue" ? "Team 1" : "Team 2";
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
      `🏁 Capture ${a.liveCaps} — ${rule.team === "Blue" ? "🔵 Blue" : "🔴 Red"} (${evt.player || "unknown"})`
    ).catch?.(() => {});

    return;
  }
/* -------------------------------------------------------------------------- */
/* until here*/
/* -------------------------------------------------------------------------- */

    if (evt.type === "score_pair") {
	  const mapNow = a.lastMapSeen || a.map;
	  if (!looseMapEqual(mapNow, a.map)) return;

	  const blue = Number(evt.blue);
	  const red = Number(evt.red);

		// 🧠 Skip invalid or corrupted score pairs
		if (isNaN(blue) || isNaN(red)) {
		  console.log(`[autoRecap] ignored invalid score_pair:`, evt);
		  return;
		}

		// 🕒 Time since map start
		const elapsedMin = (Date.now() - (a.mapStartTime || a.t0)) / 60000;

		// 🧩 Skip Half 1 if it happens too soon after map start (warmup)
		if (a.half === 0 && elapsedMin < 15) {
		  if (blue === 0 && red === 0) {
			console.log(
			  `[autoRecap] ignored early 0–0 score_pair — only ${elapsedMin.toFixed(1)} min since map start`
			);
			return;
		  }
		  // optional: you can skip *any* early score regardless of value if you want strict 15min gating
		  // return;
		}

	  a.half += 1;

	  const blueScore = blue || 0;
	  const redScore = red || 0;

	  if (a.half === 1) {
		if (Date.now() - a.t0 > windowMin * 60 * 1000) {
		  post(recapChannel, `⚠️ Ignored Half 1 — too late`).catch?.(() => {});
		  disarm(evt.from);
		  return;
		}

    a.halfScores.push({ blue: blueScore, red: redScore });

    a.liveCaps = 0;
    a.liveScore = 0;
    a.lastCap = null;
    a.liveEvents = [];

    writeLiveState(a);
		post(
		  recapChannel,
		  `⏱️ Half 1 saved — ${mapNow} (Match ${a.matchId}): 🔵 ${blueScore} / 🔴 ${redScore}`
		).catch?.(() => {});

		try {
		  const serverKey = determineServerKey(evt.from);
		  const a = armed.get(keyOf(evt.from));
		  if (!a) return;

		  const label = serverKey.toUpperCase();
		  await runRconCommand(serverKey, `hostname "fun stuff ${label} - Round 1 Score - ${blueScore}"`);
		  await runRconCommand(serverKey, `amx_map ${mapNow}`);

		  post(recapChannel, `🔄 Restarting map **${mapNow}** for Half 2...`).catch?.(() => {});
		} catch (e) {
		  console.error("[autoRecap restartMap] failed:", e);
		  post(recapChannel, "⚠️ Failed to restart map for Half 2.").catch?.(() => {});
		}
		return;
	  }

	  if (a.half === 2) {
		a.halfScores.push({ blue: blueScore, red: redScore });
    writeLiveState(a);
		const h1 = a.halfScores[0] || { blue: 0, red: 0 };
		const h2 = a.halfScores[1] || { blue: 0, red: 0 };

		const totalBlue = (h1.blue || 0) + (h2.red || 0);
		const totalRed  = (h1.red  || 0) + (h2.blue || 0);
		const winner =
		  totalBlue > totalRed ? "blue" :
		  totalRed  > totalBlue ? "red"  : "tie";

		await post(
		  recapChannel,
		  `🧾 **Recorded Match** — ${mapNow}\n + ID: ${a.matchId}\n + 🔵 Blue ${totalBlue} | 🔴 Red ${totalRed} → **${winner.toUpperCase()}**`
		).catch?.(() => {});

await post(reportChannel, `!report ${a.matchId} ${winner} --auto`).catch?.(() => {});
console.log(`[autoRecap] Reporting ${a.matchId} (${winner}) --auto`);

// 🧩 ensure serverName always set, even if armed entry missing
const resolvedKey = determineServerKey(evt.from || a?.serverIp);
const resolvedName = rconCfg[resolvedKey]?.name || resolvedKey.toUpperCase();
console.log(`[autoRecap] Building embed for ${a?.matchId} on ${resolvedKey.toUpperCase()} (${resolvedName})`);

// ----- begin: demo + logs upload helper (demos first) -----
try {
  // 🟦 1️⃣ Fetch demos first (so they’re captured before logs upload)
  await new Promise(r => setTimeout(r, 3000)); // short buffer to let HLTV close files

  let zipResult = null;
  const hltvServerKey = determineServerKey(evt.from);
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
  const serverKey = determineServerKey(evt.from);
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
    determineServerKey(evt.from) ||
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
  });
}

} catch (err) {
  console.error("[autoRecap demos+logs attach] unexpected error:", err);
}
    // ----- end: demo + logs upload helper -----

    // 🎙️ Rule 6: match fully recorded, disarm voice bots
		if (a.voiceArmed) {
		  console.log(`[autoRecap] 🎤 Voice bots disarming for match ${a.matchId}`);

		  try {
			const { stopVoiceRecording } = require("./hldsLogs");
			if (typeof stopVoiceRecording === "function") stopVoiceRecording();
		  } catch (_) {}

		  await stopVoiceBots();
		  a.voiceArmed = false;
		}

    try {
      const label = a.serverKey?.toUpperCase() || serverKey.toUpperCase();
      await runRconCommand(serverKey, `hostname "fun stuff — ${label}"`);
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
      disarm(evt.from);
      unlockServer(evt.from);
      unlockPlayersForMatch(a.matchId);
    } else {
      console.log(`[autoRecap] ${a.matchId} still in progress in DB, skipping unlock`);
    }
  } catch (e) {
    console.warn("[autoRecap delayed unlock failed]", e);
  }
}, 5000);

	  }
	}

  }

     return { 
    armFromMatchReady: ({ matchId, map, serverIp, teams }) => arm({ matchId, map, serverIp, teams }),
    disarmByIp: ip => disarm(ip),
    disarmByMatchId,
    onEvent,
    updateArmedMap,
  };

}

module.exports = { attachAutoRecap, armed, determineServerKey };
