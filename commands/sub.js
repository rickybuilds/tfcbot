//commands/sub.js
"use strict";

const { isAdmin } = require("../lib/guards");
const {
  buildTeamObjects,
  generateFairScenarios,
  buildTeamScenariosEmbed,
} = require("../lib/odds");

const servers = require("../config/rcon");
const { finalizeMatch } = require("./voteFlow"); 

/* ------------------------------------------------------------ */
/* Utilities                                                    */
/* ------------------------------------------------------------ */

function resolveUserId(arg, message) {
  if (!arg) return null;
  const s = String(arg).trim();

  const mention = s.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];

  if (/^\d{15,20}$/.test(s)) return s;

  const member = message.guild?.members?.cache.find(
    (m) =>
      m.user.username.toLowerCase() === s.toLowerCase() ||
      m.displayName.toLowerCase() === s.toLowerCase()
  );
  return member ? member.user.id : null;
}

function toArray(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.map(String);

  try {
    const parsed = JSON.parse(x);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}

  return String(x)
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function fromArray(arr) {
  return arr.join(",");
}

/* ------------------------------------------------------------ */
/* MAIN COMMAND                                                 */
/* ------------------------------------------------------------ */

async function run(message, args, deps) {
  const { state, matchesStore, elo, config, privacy, settings, streaks } = deps;

  if (!isAdmin(message)) {
    return message.channel.send("❌ You don’t have permission to use `!sub`.");
  }

  if (args.length < 2) {
    return message.channel.send("Usage: `!sub <old> <new> [matchId] [--force]`");
  }

  const oldArg = args[0];
  const newArg = args[1];
  const matchArg = args.find((a) => /^[A-Za-z0-9]{6}$/.test(a));
  const force = args.includes("--force");

  const oldId = resolveUserId(oldArg, message);
  const newId = resolveUserId(newArg, message);

  if (!oldId) return message.channel.send(`❌ Could not resolve: \`${oldArg}\``);
  if (!newId) return message.channel.send(`❌ Could not resolve: \`${newArg}\``);

  /* ------------------------------------------------------------ */
  /* Load match from memory or store                              */
  /* ------------------------------------------------------------ */

  let matchId = matchArg || null;
  let match = null;

  if (matchId) {
    match =
      matchesStore?.findById?.(matchId) ||
      state.matches.find((m) => String(m.id) === String(matchId));
  } else {
    match = [...state.matches].reverse().find((m) => m.status !== "completed");
    matchId = match?.id;
  }

  if (!matchId || !match) {
    return message.channel.send("❌ No match found.");
  }

  /* ------------------------------------------------------------ */
  /* Load DB match                                                */
  /* ------------------------------------------------------------ */

  const dbMatch = elo.db
    .prepare("SELECT * FROM matches WHERE match_id=?")
    .get(matchId);

  if (!dbMatch) {
    return message.channel.send("❌ Could not load match from DB.");
  }

  const blueIds = toArray(dbMatch.blue_ids);
  const redIds = toArray(dbMatch.red_ids);

  const inBlue = blueIds.includes(oldId);
  const inRed = redIds.includes(oldId);

  if (!inBlue && !inRed) {
    return message.channel.send(`❌ <@${oldId}> is not in match \`${matchId}\`.`);
  }

  const isCompleted = dbMatch.status === "completed";

  /* ------------------------------------------------------------ */
  /* COMPLETED MATCH LOGIC                                        */
  /* ------------------------------------------------------------ */

  if (isCompleted && !force) {
    return message.channel.send(
      "❌ Match is completed — use `--force` to override."
    );
  }

  if (isCompleted && force) {
    // Replace in DB
    elo.db.prepare(`
      UPDATE matches
      SET blue_ids = REPLACE(blue_ids, ?, ?),
          red_ids  = REPLACE(red_ids, ?, ?)
      WHERE match_id=?
    `).run(oldId, newId, oldId, newId, matchId);

    return message.channel.send(
      `✅ Forced substitution in completed match \`${matchId}\`: <@${oldId}> → <@${newId}>`
    );
  }

  /* ------------------------------------------------------------ */
  /* IN-PROGRESS MATCH LOGIC                                      */
  /* ------------------------------------------------------------ */

	// ------------------------------------------------------------
	// 🔒 Player lock maintenance for !sub (SAFE)
	// ------------------------------------------------------------
	if (state?.lockedPlayers) {
	  const oldPid = String(oldId);
	  const newPid = String(newId);
	  const mid    = String(matchId);

	  // unlock OUT player (only if locked to this match)
	  const oldCurrent = state.lockedPlayers.get(oldPid);
	  if (String(oldCurrent) === mid) {
		state.lockedPlayers.delete(oldPid);
		console.log(`[playerLock] ✅ !sub unlocked OUT player ${oldPid} from match ${mid}`);
	  } else {
		console.log(`[playerLock] !sub did not unlock ${oldPid} (locked to ${oldCurrent}, not ${mid})`);
	  }

	  // lock IN player, but don't override if they're locked elsewhere
	  const newCurrent = state.lockedPlayers.get(newPid);
	  if (newCurrent && String(newCurrent) !== mid) {
		console.log(`[playerLock] ❌ Not locking IN player ${newPid}: already locked to match ${newCurrent}`);
	  } else {
		state.lockedPlayers.set(newPid, mid);
		console.log(`[playerLock] 🔒 !sub locked IN player ${newPid} to match ${mid}`);
	  }
	}

  // Swap
  if (inBlue) {
    dbMatch.blue_ids = JSON.stringify(
      blueIds.map(id => (id === oldId ? newId : id))
    );
  }

  if (inRed) {
    dbMatch.red_ids = JSON.stringify(
      redIds.map(id => (id === oldId ? newId : id))
    );
  }

  // Save updated teams
  elo.db.prepare(`
    UPDATE matches SET blue_ids=?, red_ids=? WHERE match_id=?
  `).run(dbMatch.blue_ids, dbMatch.red_ids, matchId);

  let rebuiltBlue = buildTeamObjects(toArray(dbMatch.blue_ids), elo);
  let rebuiltRed = buildTeamObjects(toArray(dbMatch.red_ids), elo);
  const allPlayers = [...rebuiltBlue, ...rebuiltRed];

  /* ------------------------------------------------------------ */
  /* Recalculate odds                                             */
  /* ------------------------------------------------------------ */

  const scenarios = generateFairScenarios(allPlayers, elo, 4);

	// ------------------------------------------------------------
	// Scenario 1 = actual team assignment after substitution
	// ------------------------------------------------------------
	const scenario1 = scenarios[0];

	const newBlueIds = scenario1.blue.map(p => String(p.id));
	const newRedIds  = scenario1.red.map(p => String(p.id));
	const teamScenarioState = JSON.stringify({
	  version: 1,
	  selected: 1,
	  scenarios: scenarios.map(s => ({
		blue: s.blue.map(p => String(p.id)),
		red: s.red.map(p => String(p.id)),
	  })),
	});

	// Update DB with REAL teams
	const matchColumns = elo.db.prepare("PRAGMA table_info(matches)").all();
	if (!matchColumns.some(c => c.name === "team_scenarios")) {
	  elo.db.exec("ALTER TABLE matches ADD COLUMN team_scenarios TEXT");
	}
	elo.db.prepare(`
	  UPDATE matches
	  SET blue_ids = ?, red_ids = ?, team_scenarios = ?
	  WHERE match_id = ?
	`).run(
	  JSON.stringify(newBlueIds),
	  JSON.stringify(newRedIds),
	  teamScenarioState,
	  matchId
	);

	// Update in-memory DB match object
	dbMatch.blue_ids = JSON.stringify(newBlueIds);
	dbMatch.red_ids  = JSON.stringify(newRedIds);

	// Rebuild team objects from scenario 1
	rebuiltBlue = scenario1.blue.map(p => ({
	  id: String(p.id),
	  name: p.name
	}));

	rebuiltRed = scenario1.red.map(p => ({
	  id: String(p.id),
	  name: p.name
	}));

  // Find server IP
	const serverEntry = Object.values(servers).find(s => {
	  const a = (s.name || "").toLowerCase();
	  const b = (dbMatch.server_name || "").toLowerCase();
	  return a === b || b.includes(a) || a.includes(b);
	}) || null;


  const fullIp = serverEntry
    ? `${serverEntry.host}:${serverEntry.port}`
    : "Unknown";
	
  const joinUrl = serverEntry?.url || `steam://connect/${fullIp}/pickup`;
	
  const oddsEmbed = buildTeamScenariosEmbed({
    matchId,
    serverName: dbMatch.server_name,
    mapName: dbMatch.map_name,
    ip: fullIp,
    scenarios,
    elo,
    match: {
      blueTeam: rebuiltBlue,
      redTeam: rebuiltRed,
      rng_multiplier: dbMatch.rng_multiplier || 1.0,
    },
  });

  // Confirmation in pickup channel
  await message.channel.send(
    `🔄 Substitution applied in match \`${matchId}\`:\n<@${oldId}> → <@${newId}>\n♻️ Odds recalculated.`
  );

  // Full odds embed → odds channel
  const oddsChannel = message.guild.channels.cache.get(process.env.ODDS_CHANNEL_ID);
  if (oddsChannel) {
    await oddsChannel.send({ embeds: [oddsEmbed] });
  }

  /* ------------------------------------------------------------ */
  /* Regenerate **Match Ready** using voteFlow.finalizeMatch()    */
  /* ------------------------------------------------------------ */

  const pickupChannel = message.guild.channels.cache.get(process.env.PICKUP_CHANNEL_ID);

	if (pickupChannel) {
	  const embed = {
		color: 0x57f287,
		title: `Match Updated — ${dbMatch.server_name} — ${dbMatch.map_name}`,
		description:
		  `**Match ID:** ${matchId}\n` +
		  `Server: **${dbMatch.server_name}**\n` +
		  `IP: **${fullIp}**\n` +
		  `Password: pickup\n` +
		  `Join: ${joinUrl}\n` +
		  `Map: **${dbMatch.map_name}**\n` +
		  `Mode: **${dbMatch.mode || "STANDARD"}**\n\n` +
		  `🌐 [NoNamePickup Website](https://nonamepickup.servehalflife.com/)\n`,
		fields: [
		  {
			name: "Blue Team 🔵",
			value: rebuiltBlue.map(p => p.name).join("\n") || "_empty_",
			inline: true,
		  },
		  {
			name: "Red Team 🔴",
			value: rebuiltRed.map(p => p.name).join("\n") || "_empty_",
			inline: true,
		  },
		],
		timestamp: new Date(),
	  };

	  await pickupChannel.send({ embeds: [embed] });
	}

 // ------------------------------------------------------------
// Update memory state
// ------------------------------------------------------------

const idx = state.matches.findIndex((m) => String(m.id) === String(matchId));
if (idx !== -1) {
	state.matches[idx].blue_ids = JSON.stringify(newBlueIds);
	state.matches[idx].red_ids  = JSON.stringify(newRedIds);

  state.matches[idx].blueTeam = rebuiltBlue.map(p => ({
    id: p.id,
    name: p.name
  }));
  state.matches[idx].redTeam = rebuiltRed.map(p => ({
    id: p.id,
    name: p.name
  }));
}

// 🔥 NEW: ensure match object (from matchesStore or state) also gets team hydration
match.blueTeam = rebuiltBlue.map(p => ({ id: p.id, name: p.name }));
match.redTeam  = rebuiltRed.map(p => ({ id: p.id, name: p.name }));

console.log(`[sub] Updated ${matchId}: ${oldId} → ${newId}`);
}
module.exports = { run };
