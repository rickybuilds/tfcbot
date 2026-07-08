// index.js
"use strict";

// ============================================================================
// Environment and configuration
// ============================================================================

require("dotenv").config();
console.log("[MAIN] Loaded state file:", require.resolve("./lib/state"));
console.log("[DEBUG] ADMIN_ROLE_ID =", process.env.ADMIN_ROLE_ID);

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const config = require("./config");

// ============================================================================
// Core libraries and services
// ============================================================================

const { SettingsDB }   = require("./lib/settings");
const { state, loadServersFile, loadMappoolFile, loadAdlMappoolFile } = require("./lib/state");
const { PrivacyDB }    = require("./lib/privacy");
const { MatchStore }   = require("./lib/matchStore");
const { refreshBotName } = require("./lib/botName");
const { scheduleBackups } = require("./lib/backup");
const { startSpeedrunPlayerLinkSync } = require("./services/speedrunPlayerLinkSync");
const { determineServerKey } = require("./services/autoRecap");
const { runRconCommand } = require("./services/rconClient");

// Jail system
const { JailStore } = require("./lib/jailStore");
const { startJailWatcher } = require("./lib/jailWatcher");

// TFC Server Commands
const rconCommands = require("./commands/rconCommands");

// commands (ADL + health)
const addadl    = require("./commands/addadl");
const removeadl = require("./commands/removeadl");
const health    = require("./commands/health");

// HLDS log listener + auto-recap
const { startHldsLogReceiver } = require("./services/hldsLogs");
const { attachAutoRecap }      = require("./services/autoRecap");
const { runCasualLogs } = require("./services/hldsCasualLogs");
const { startSpeedrunWatcher } = require("./services/speedrunWatcher");
const mysqlPool = require("./lib/mysql");
const { SteamLinks } = require("./lib/steamLinks");

// QoL / persistence / decay
const { QueueStore } = require("./lib/queueStore");
const { BanStore }   = require("./lib/banStore");
const { scheduleDecayIfNeeded } = require("./lib/eloDecay");
const moderation = require("./commands/moderation");

// ============================================================================
// Shared service initialization
// ============================================================================

// robust Elo import (supports multiple export styles)
const EloAny = require("./lib/elo");
let elo;
if (typeof EloAny === "function") elo = new EloAny("elo.db");
else if (EloAny && typeof EloAny.EloDB === "function") elo = new EloAny.EloDB("elo.db");
else if (EloAny && typeof EloAny.default === "function") elo = new EloAny.default("elo.db");
else if (EloAny && typeof EloAny.getRating === "function") elo = EloAny;
else throw new Error("lib/elo: export must be class or instance with getRating()");

// init singletons
const settings     = new SettingsDB("bot.db");
const privacy      = new PrivacyDB("elo.db");
const matchesStore = new MatchStore("/root/tfcbot/elo.db");
const queueStore   = new QueueStore("queue.json");
const banStore     = new BanStore("bot.db");
const steamLinks = new SteamLinks();

// Jail system
const jailStore    = new JailStore();

// WinStreaks (live from elo.db)
const { WinStreakStore } = require("./lib/winstreak");
const streaks = new WinStreakStore("/root/tfcbot/elo.db");
const shuffle = require("./commands/shuffle");

// ============================================================================
// Shared state preload
// ============================================================================

// Global toggles
state.showVoters   = settings.getBool?.("showVoters", true) ?? true;
state.showEloNames = settings.getBool?.("showEloNames", true) ?? true;

// Static configuration
loadServersFile();
loadMappoolFile();
loadAdlMappoolFile();

// Persistent runtime state
state.matches       = matchesStore.getRecent?.(50) ?? [];
state.queue         = queueStore.load?.() ?? [];
state.bannedUsers   = new Set();
state.tempBanTimers = new Map();
state.MAX_PLAYERS   = Number(process.env.ADL_REQUIRED_PLAYERS || 8);
if (!state.lockedServers) state.lockedServers = new Set();
if (!state.lockedPlayers) state.lockedPlayers = new Map();
console.log("[INIT] Lock sets initialized:", {
  servers: state.lockedServers.size,
  players: state.lockedPlayers.size
});

// ============================================================================
// Command registry and shared dependencies
// ============================================================================

const registry = new Map();
function persistQueueSoon() { try { queueStore.save(state.queue); } catch {} }
global.persistQueueSoon = persistQueueSoon;

const deps = { 
  config, 
  state, 
  settings, 
  elo, 
  privacy, 
  matchesStore, 
  banStore, 
  streaks, 
  // 👇 JAIL SYSTEM
  jailStore
};

const pickupMute = require("./commands/mute");
registry.set("mute", (m, a) => pickupMute.execute(m, a, deps));
registry.set("pmute", (m, a) => pickupMute.execute(m, a, deps));
registry.set("pickupmute", (m, a) => pickupMute.execute(m, a, deps));
registry.set("unmute", (m, a) => pickupMute.execute(m, a, deps));
registry.set("punmute", (m, a) => pickupMute.execute(m, a, deps));
registry.set("mutelist", (m, a) => pickupMute.execute(m, a, deps));

state.pickupMutedUsers = new Set();

function loadPickupMutedUsers() {
  matchesStore.db.all(
    `SELECT discord_id FROM pickup_mutes`,
    [],
    (err, rows) => {
      if (err) {
        console.error("[pickup_mute] cache load failed:", err);
        return;
      }

      state.pickupMutedUsers = new Set(rows.map(r => String(r.discord_id)));
      console.log(`[pickup_mute] loaded ${state.pickupMutedUsers.size} muted users`);
    }
  );
}

loadPickupMutedUsers();
deps.loadPickupMutedUsers = loadPickupMutedUsers;

// ============================================================================
// Command registration
// ============================================================================

// Supporters
const supporters = require("./commands/supporters");
registry.set("addsupport", (m, a) => supporters.execute(m, a, deps));

// Commands with register() entry points
require("./commands/queue").register(registry, deps);
require("./commands/eloAdminAdjust").register(registry, deps);
require("./commands/files").register(registry, deps);
require("./commands/admin").register(registry, deps);
require("./commands/voteFlow").register(registry, deps);
require("./commands/matches").register(registry, deps);
require("./commands/elo").register(registry, deps);
require("./commands/help").register(registry, deps);
require("./commands/searchelo").register(registry, deps);
require("./commands/maplist").register(registry, deps);
require("./commands/adlmaplist").register(registry, deps);
require("./commands/rules").register(registry, deps);
require("./commands/setmap").register(registry, deps);
require("./commands/onboarding").register(registry, deps);
require("./commands/privacy").register(registry, deps);
require("./commands/purgematches").register(registry, deps);
require("./commands/moderation").register(registry, deps);
require("./commands/tfcmap").register(registry, deps);
require("./commands/settings").register(registry, deps);
require("./commands/ranks").register(registry, deps);
require("./commands/mapcaps").register(registry, deps);
require("./commands/idea").register(registry, deps);
require("./commands/noticeRoles").register(registry, {
  state,
  elo,
  privacy,
  config,
});

// Admin and match utilities
const unlock = require("./commands/unlock");
registry.set(unlock.name.toLowerCase(), (m, a) => unlock.execute(m, a, deps));

try { require("./commands/lastauto").register(registry, deps); } catch {}
const lastmaps = require("./commands/lastmaps");
registry.set(lastmaps.name.toLowerCase(), (m, a) => lastmaps.run(m, deps));

const sub = require("./commands/sub");
registry.set("sub", (m, a) => sub.run(m, a, deps));

// SQL Additions for Servers
const tfcAdmin = require("./commands/tfcAdmin");
registry.set("tfcadmin", (m, a) => tfcAdmin.execute(m, a, deps));
registry.set("tfcadmins", (m, a) => tfcAdmin.list(m, a, deps));

// Jail commands
require("./commands/jail").register(registry, deps);
require("./commands/unjail").register(registry, deps);
require("./commands/jaillist").register(registry, deps);

// RCON commands (!timeleft, !rcon <cmd>)
registry.set("rcon", (m, a) => rconCommands.execute(m, a, deps));

// ✅ Make !timeleft dynamic and future-proof
registry.set("timeleft", (message, args) => {
  // Load all servers from config dynamically
  const allServers = Object.keys(require("./config/rcon") || {});
  let serverKey = null;

  // Normalize any given argument to a matching server name
  if (args.length > 0) {
    const requested = args[0].toLowerCase();
    serverKey = allServers.find(srv => srv.toLowerCase() === requested);
  }

  // 🟢 If a specific server was found, run it for that server only
  if (serverKey) {
    return rconCommands.execute(message, [serverKey, "timeleft"], deps);
  }

  // 🔁 Otherwise, run it globally (show all servers)
  return rconCommands.execute(message, ["timeleft"], deps);
});

// Steam account commands
const steamids = require("./commands/steam/steamids");
const whoissteam = require("./commands/steam/whoissteam");
const linksteam = require("./commands/steam/linksteam");
const unlinksteam = require("./commands/steam/unlinksteam");
const missinglink = require("./commands/steam/missinglink");
const linkprogress = require("./commands/steam/linkprogress");
registry.set("linkprogress", (m, a) => linkprogress.execute(m, a, deps));
registry.set("steamids", (m, a) => steamids.execute(m, a, deps));
registry.set("whoissteam", (m, a) => whoissteam.execute(m, a, deps));
registry.set("linksteam", (m, a) => linksteam.execute(m, a, deps));
registry.set("unlinksteam", (m, a) => unlinksteam.execute(m, a, deps));
registry.set("missinglink", (m, a) => missinglink.execute(m, a, deps));

// Elo exports and lookup commands
const elocsv = require("./commands/elocsv");
registry.set("elocsv", (message, args) => elocsv.run(message, deps));

const eloUsers = require("./commands/eloUsers");
if (eloUsers?.execute) {
  registry.set("allelo", (m, a) => eloUsers.execute(m, a, deps));
  registry.set("deluser", (m, a) => eloUsers.execute(m, a, deps));
}

const permapelo = require("./commands/permapelo");
if (permapelo?.run) {
  registry.set((permapelo.name || "permapelo").toLowerCase(), (m, a) => permapelo.run(m, deps));
  (permapelo.aliases || []).forEach(a =>
    registry.set(String(a).toLowerCase(), (m) => permapelo.run(m, deps))
  );
}

//EloWith @user
const elowith = require("./commands/elowith");
if (elowith?.run) {
  registry.set(elowith.name.toLowerCase(), (m, a) => elowith.run(m, deps));
  (elowith.aliases || []).forEach(a =>
    registry.set(String(a).toLowerCase(), (m) => elowith.run(m, deps))
  );
}

//EloAgainst @user
const eloagainst = require("./commands/eloagainst");
if (eloagainst?.run) {
  registry.set(eloagainst.name.toLowerCase(), (m, a) => eloagainst.run(m, deps));
  (eloagainst.aliases || []).forEach(a =>
    registry.set(String(a).toLowerCase(), (m) => eloagainst.run(m, deps))
  );
}

// Developer-only version of EloWith
const elowithdev = require("./commands/elowithdev");
if (elowithdev?.run) {
  registry.set(elowithdev.name.toLowerCase(), (m, a) => elowithdev.run(m, deps));
  (elowithdev.aliases || []).forEach(a =>
    registry.set(String(a).toLowerCase(), (m) => elowithdev.run(m, deps))
  );
}

const serverhealth=require("./commands/serverhealth");
registry.set("serverhealth",(m,a)=>serverhealth.execute(m,a,deps));

// ADL, shuffle, and health commands
registry.set(addadl.name.toLowerCase(), (m) => addadl.run(m, deps));
addadl.aliases.forEach(a =>
  registry.set(String(a).toLowerCase(), (m) => addadl.run(m, deps))
);

// Shuffle commands
registry.set("shuffle", (m, a) => shuffle.execute(m, a, deps));

registry.set(removeadl.name.toLowerCase(), (m) => removeadl.run(m, deps));
removeadl.aliases.forEach(a =>
  registry.set(String(a).toLowerCase(), (m) => removeadl.run(m, deps))
);

// health
registry.set(health.name.toLowerCase(), (m) => health.run(m, deps));

// ============================================================================
// Discord client and client-dependent registrations
// ============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});
registry.client = client;
client.persistQueueSoon = persistQueueSoon;

// Member lifecycle hooks
const { register: memberLeaves } = require("./commands/memberLeaves");
memberLeaves(client, config);

// now extend deps with client
deps.client = client;

// ban roles
const ROLE_PERMABAN = config.roles.permaban;
const ROLE_TEMPBAN  = config.roles.tempban;
const ROLE_JAIL     = config.roles.jail;

// Client-dependent utility commands
const spintest = require("./commands/spintest");
registry.set("spintest", (m, a) => spintest.execute(m, a, deps));

const kix = require("./commands/kix");
const kixHandler = (m, a) => kix.execute(m, a, deps);
registry.set(kix.name.toLowerCase(), kixHandler);
(kix.aliases || []).forEach(alias => {
  registry.set(alias.toLowerCase(), kixHandler);
});

const light = require("./commands/light");
const lightHandler = (m, a) => light.execute(m, a, deps);
registry.set(light.name.toLowerCase(), lightHandler);
(light.aliases || []).forEach(alias => {
  registry.set(alias.toLowerCase(), lightHandler);
});

const emilio = require("./commands/emilio");
const emilioHandler = (m, a) => emilio.execute(m, a, deps);
registry.set(emilio.name.toLowerCase(), emilioHandler);
(emilio.aliases || []).forEach(alias => {
  registry.set(alias.toLowerCase(), emilioHandler);
});

// ============================================================================
// Discord ready lifecycle
// ============================================================================

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await refreshBotName(client, state); } catch {}

  try {
    await startSpeedrunWatcher({
        client,
        pool: mysqlPool,
        config,
        logger: console,
    });
} catch (e) {
    console.error("[SPEEDRUN-WATCHER] failed:", e);
}

startSpeedrunPlayerLinkSync({
  db: matchesStore.db,
  speedrunDb: mysqlPool,
});

  try { startJailWatcher(client, jailStore); } catch (e) { console.error("[JAIL-WATCHER] failed:", e); }
    // Auto-re-jail anyone who rejoins while still flagged
  client.on("guildMemberAdd", async (member) => {
    const rec = jailStore.get(member.id);
    if (!rec) return;

    try {
      // Treat anyone who left while jailed as indefinitely jailed
      // (either existing long timestamp, or normal jail converted to infinite)
      const INFINITE_JAIL = 32503680000000; // year 2999
      rec.expires = INFINITE_JAIL;
      jailStore.set(member.id, rec);

      // strip all non-@everyone roles
      for (const [, role] of member.roles.cache) {
        if (role.name !== "@everyone") await member.roles.remove(role).catch(() => {});
      }

      // re-add the jail role
      await member.roles.add(config.roles.jail).catch(() => {});

      // log to audit
      const auditCh = member.guild.channels.cache.get(config.channels.audit);
      auditCh?.send(`🔒 ${member} rejoined and was automatically **re-jailed** (indefinite until manual !unjail).`).catch(() => {});
    } catch (err) {
      console.error("[JAIL rejoin]", err);
    }
  });


  // HLDS log receiver + auto-recap
  try {
	const recapChannel = config.channels.recap;
	const reportChannel = config.channels.pickup;

    const autoRecap = attachAutoRecap(
      { client, matchesStore, settings, state, registry },
      {
        windowMin: 30,
        ttlMin: 90,
        recapChannel: recapChannel,   // half + recap
        reportChannel: reportChannel, // !report
      }
    );

    registry.autoRecap = autoRecap;
    state.autoRecap = autoRecap;

    const udpPort = Number(process.env.HL_LOG_PORT || 27500);
    const allowedSources = (process.env.HL_ALLOWED_SOURCE || "108.61.128.120")
      .split(",").map(s => s.trim()).filter(Boolean);

    startHldsLogReceiver(client, {
      port: udpPort,
      allowedSources,
      relayToChannelId: null,
      pairScores: true,
      pairWindowMs: 8000,
      }, async (evt) => {
    // If the armed match map changed manually before !rs was used,
    // burn the one-time restart so it cannot be used mid-round later.
    if (evt.type === "map" && state.restartRequest && !state.restartRequest.used) {
      const rs = state.restartRequest;

      const armedIp = String(rs.serverIp || "").split(":")[0];
      const fromIp = String(evt.from || "").split(":")[0];
      const newMap = String(evt.name || "").toLowerCase();
      const armedMap = String(rs.map || "").toLowerCase();

      if (armedIp === fromIp && newMap && armedMap && newMap !== armedMap) {
        rs.used = true;
        rs.disarmedReason = "manual_map_change";

        console.log(
          `[!rs] disarmed reason=manual_map_change armed=${armedMap} current=${newMap} from=${evt.from}`
        );
      }
    }

    if (evt.type === "restart_request") {
      const rs = state.restartRequest;

      if (!rs) {
        console.log("[!rs] denied reason=no_restart_armed", evt);
        return;
      }

      if (rs.used) {
        console.log(`[!rs] denied reason=already_used detail=${rs.disarmedReason || "used"}`, evt);
        return;
      }

      const armedIp = String(rs.serverIp || "").split(":")[0];
      const evtIp = String(evt.from || "").split(":")[0];

      if (armedIp !== evtIp) {
        console.log(`[!rs] denied reason=wrong_server armed=${rs.serverIp} from=${evt.from}`);
        return;
      }

      if (!rs.map || !/^[a-zA-Z0-9_-]+$/.test(rs.map)) {
        console.log(`[!rs] denied reason=invalid_map map=${rs.map}`);
        return;
      }

      const links = await steamLinks.getDiscordBySteam(evt.steamid);
      const link = links?.[0];

      if (!link?.discord_id) {
        console.log(`[!rs] denied reason=steam_not_linked steamid=${evt.steamid}`);
        return;
      }

      const discordId = String(link.discord_id);
      const serverKey = determineServerKey(rs.serverIp);

      console.log(`[!rs] request player=${evt.player || "unknown"} steamid=${evt.steamid} team=${evt.team || "?"} from=${evt.from}`);
      const restartMsg =
        `🗺️ Restarting to **${rs.map}** | Triggered by <@${discordId}> (${evt.steamid})`;

      console.log(restartMsg);

      try {
        const ch = await client.channels.fetch(config.channels.recap);
        await ch?.send(restartMsg);
      } catch (err) {
        console.warn("[!rs] failed to post restart message:", err);
      }

      rs.used = true;

      try {
        await runRconCommand(serverKey, `amx_map ${rs.map}`);
        console.log(`[!rs] amx_map ${rs.map} sent OK to ${serverKey}`);
      } catch (err) {
        rs.used = false;
        console.error(`[!rs] failed to restart ${rs.map} on ${serverKey}:`, err);
      }

      return;
    }

    autoRecap.onEvent(evt);
    global.lastHldsPacketAt = Date.now();
  });
  } catch (e) { console.error("[HLDS-LOG] failed:", e); }

  // TODO: keep your ban restore + backups + decay logic here
});

// ============================================================================
// Queue activity tracking
// ============================================================================

// Update queue lastSeenAt globally when user talks anywhere in the server
client.on("messageCreate", (message) => {
  try {
    if (!message.guild) return;               // Ignore DMs
    if (message.author.bot) return;           // Ignore bots
    const id = message.author.id;
    if (!id) return;

    // Only touch if they're in the queue
    const player = state.queue.find(q => String(q.id) === String(id));
    if (player) {
      player.lastSeenAt = Date.now();
      client.persistQueueSoon?.();
    }
  } catch (err) {
    console.error("[AFK heartbeat update failed]", err);
  }
});

const ALLOWED_PICKUP_MUTED_MESSAGES = new Set([
  "!add",
  "!addadl",
  "++",
  "**",
]);

function isPickupMuted(discordId) {
  return state.pickupMutedUsers?.has(String(discordId));
}

// ============================================================================
// Message command router
// ============================================================================

client.on("messageCreate", async (message) => {
  try {
    const isSelf = message.author?.id === client.user?.id;
    if (message.author.bot && !isSelf) return;

    if (state?.bannedUsers?.has(String(message.author.id))) return;
    const member = message.member;
    if (member) {
      const hasPerma = member.roles?.cache?.has(ROLE_PERMABAN);
      const hasTemp  = member.roles?.cache?.has(ROLE_TEMPBAN);
      const hasJail  = member.roles?.cache?.has(ROLE_JAIL);
      if (hasPerma || hasTemp || hasJail) {
        state.bannedUsers.add(String(message.author.id));
        return;
      }
    }

    if (await moderation.handleVoteMediaModeration(message, state, config)) {
      return;
    }

    const raw = (message.content || "").trim();
    if (!raw) return;

    const rawLower = raw.toLowerCase();
    if (message.guild && isPickupMuted(message.author.id)) {
      if (!ALLOWED_PICKUP_MUTED_MESSAGES.has(rawLower)) {
        try {
          await message.delete();
        } catch (err) {
          console.warn("[pickup_mute] delete failed:", err.message);
        }
        return;
      }
    }

    // ✅ handle bare specials like ++, --, ++adl, --adl (case-insensitive)
    const BARE_SPECIAL = new Set(["++", "--", "++adl", "--adl", "**"]);

    if (BARE_SPECIAL.has(rawLower)) {
      const fn = registry.get(rawLower); // registry keys are lowercase
      if (!fn) console.log("[DEBUG] No handler for", rawLower);
      if (fn) return fn(message, []);
    }

	// ✅ handle DMs
	if (!message.guild) {
	  const m = raw.match(/^!(\w+)/);
	  const cmd = (m?.[1] || "").toLowerCase();

	  // ⬇️ Added "privacy" here
	  const dmAllowed = [
		"elo",
		"elocsv",
		"permapelo",
		"pmelo",
		"elowith",
		"eloagainst",
		"help",
		"privacy"
	  ];

		if (dmAllowed.includes(cmd) && registry.has(cmd)) {
		  // Extract arguments after the command (e.g., "on" or "off")
		  const args = raw.slice(m[0].length).trim().split(/\s+/).filter(Boolean);
		  return registry.get(cmd)(message, args);
		}

	  return;
	}

    // ✅ normal prefix commands (always case-insensitive)
    if (!raw.startsWith(config.PREFIX)) return;
    const parts = raw.slice(config.PREFIX.length).trim().split(/\s+/);
    const command = (parts.shift() || "").toLowerCase();
    const args = parts;

    if (command === "set" && args[0]?.includes(":") && registry.has("settings:set")) {
      return registry.get("settings:set")(message, args);
    }

    // 👇 your custom !logs command
  if (command === "logs") {
    const mapName = args.join(" ").trim();

    if (!mapName) {
      return message.reply("Usage: !logs <mapname>");
    }

    return runCasualLogs({
      mapName,
      message,
      config,
    });
  }

    // ✅ normal registry commands
    const fn = registry.get(command);
    if (fn) {
      const res = await fn(message, args);
      if (Array.isArray(state.queue)) persistQueueSoon();
      return res;
    }
  } catch (e) {
    console.error("[router error]", e);
    try { await message.channel.send("Something went wrong handling that command."); } catch {}
  }
});

// ============================================================================
// Discord login
// ============================================================================

if (!config.DISCORD_TOKEN) { console.error("Missing DISCORD_TOKEN in .env"); process.exit(1); }
client.login(config.DISCORD_TOKEN).catch(err => { console.error("Discord login failed:", err); process.exit(1); });
