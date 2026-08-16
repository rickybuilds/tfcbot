// commands/queue.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { refreshBotName } = require("../lib/botName");
const { mention, formatPlayerName, clearAnyTimer } = require("../lib/util");
const adl = require("../lib/adl");
const { supporterBadge } = require("../lib/supporters");
const STATUS_COOLDOWN_MS = 90_000; // 90 seconds
const lockedReplyCooldown = new Map();
const LOCKED_REPLY_COOLDOWN_MS = 60 * 1000; // 1 minute
let lastStatusUsedAt = 0; // global cooldown timestamp

const ADMIN_ROLE = process.env.ADMIN_ROLE_ID || "";
const HLDS_QUEUE_COMMANDS = new Map([
  ["!add", { action: "add", adl: false }],
  ["++", { action: "add", adl: false }],
  ["!addadl", { action: "add", adl: true }],
  ["++adl", { action: "add", adl: true }],
  ["**", { action: "add", adl: true }],
  ["!remove", { action: "remove", adl: false }],
  ["--", { action: "remove", adl: false }],
]);

/* ------------------ local helpers ------------------ */
function isAdmin(message) {
  return ADMIN_ROLE && message.member?.roles?.cache?.has(ADMIN_ROLE);
}
function now() { return Date.now(); }

function parseHldsQueueCommand(text) {
  return HLDS_QUEUE_COMMANDS.get(String(text || "").trim().toLowerCase()) || null;
}

function safeRconText(text) {
  return String(text || "")
    .replace(/[\r\n"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

async function notifyHldsVoteStarted(players, runRconCommand) {
  if (typeof runRconCommand !== "function") return 0;

  const serverKeys = [...new Set(
    (players || [])
      .filter(p => p.queueOrigin === "hlds" && p.sourceServerKey)
      .map(p => String(p.sourceServerKey))
  )];

  const results = await Promise.allSettled(
    serverKeys.map(serverKey =>
      runRconCommand(serverKey, 'say "[Queue] Vote started! Vote in Discord now."')
    )
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(
        `[hlds queue] Vote notice failed for ${serverKeys[index]}:`,
        result.reason?.message || result.reason
      );
    }
  });

  return results.filter(result => result.status === "fulfilled").length;
}

async function maybeStartAutoFullVote(
  message,
  state,
  { runner = global.runFullVoteFlow } = {}
) {
  const max = state.MAX_PLAYERS || 8;

  console.log(
    `[autoFullVote check] count=${state.queue.length}/${max} vote=${!!state.vote} voting=${!!state.isVotingInProgress} runner=${typeof runner}`
  );

  if (
    state.queue.length !== max ||
    state.vote ||
    state.isVotingInProgress ||
    state.isVoteStarting ||
    state.voteLock ||
    typeof runner !== "function"
  ) {
    return false;
  }

  // Start immediately once the queue reaches capacity. The vote runner sets
  // its own startup guards synchronously before doing any asynchronous work.
  Promise.resolve(runner(message)).catch(console.error);
  return true;
}

// inline getNumber so we don’t depend on settings.js exports
function getNumber(settings, key, fb) {
  try {
    if (typeof settings.getNumber === "function") {
      const n = Number(settings.getNumber(key, fb));
      return Number.isFinite(n) ? n : fb;
    }
    const raw = settings.get?.(key);
    const n = Number(raw);
    return Number.isFinite(n) ? n : fb;
  } catch { return fb; }
}

/* ------------------ cleanup helpers ------------------ */
function cleanupQueue(state, settings) {
  const idleMin = getNumber(settings, "queue:idle_min", 120); // default 120
  const idleMs = idleMin * 60 * 1000;
  const ts = Date.now();
  const before = state.queue.length;

  state.queue = state.queue.filter(p => !p.lastSeenAt || (ts - p.lastSeenAt) < idleMs);
  return before - state.queue.length;
}

/* ------------------ rendering helpers ------------------ */
function queueLines(state, elo, privacy) {
  if (!state.queue.length) return "_empty_";

  return state.queue.map(p => {
    try {
      const registeredName = typeof elo?.getDisplayName === "function"
        ? elo.getDisplayName(p.id, p.name)
        : p.name;
      const base = formatPlayerName(
        state,
        elo,
        p.id,
        registeredName || `Player#${String(p.id).slice(-4)}`,
        privacy,
        false
      );

      const name = `${base}${supporterBadge(p.id)}`;

      return p.adlVote ? `${name} (ADL)` : name;
    } catch (e) {
      console.error("[queueLines] failed formatting", p, e);
      return mention(p.id);
    }
  }).join(", ");
}

function adlProgress(state) {
  const max = state.MAX_PLAYERS || Number(process.env.ADL_REQUIRED_PLAYERS || 8);
  const frozenIds = (state.queue || []).slice(0, max).map(p => p.id);
  const { useAdl, votes, required } = adl.shouldUseAdl(frozenIds, process.env);
  const need = Math.max(0, required - votes);
  return `ADL votes ${votes}/${required} — ${useAdl ? "**READY**" : `need ${need} more`}`;
}

async function postQueueBoard(channel, state, elo, privacy) {
  const emb = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`Player Queue — (${state.queue.length}/${state.MAX_PLAYERS || 8})`)
    .setDescription(queueLines(state, elo, privacy))
    .setTimestamp();

  if (state.queue.some(p => p.adlVote)) {
    emb.addFields({ name: "ADL", value: adlProgress(state), inline: false });
  }

  await channel.send({ embeds: [emb] });
}

/* ------------------ register commands ------------------ */
function register(reg, {
  client,
  config,
  state,
  elo,
  banStore,
  settings,
  privacy,
  steamLinks,
  runRconCommand,
}) {
  const add = async (message, isAdl = false) => {
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;
    const id = message.author.id;

    if (state.isVotingInProgress || state.vote) {
      console.log(`[queue] Ignored add from ${id} while vote is active`);
      return;
    }
	// Prevent players currently in an active match from joining another queue
	if (state.lockedPlayers && state.lockedPlayers.has(String(id))) {
  const matchId = state.lockedPlayers.get(String(id));
  const now = Date.now();
  for (const [userId, timestamp] of lockedReplyCooldown) {
    if (now - timestamp > LOCKED_REPLY_COOLDOWN_MS) lockedReplyCooldown.delete(userId);
  }
  const lastReply = lockedReplyCooldown.get(id) || 0;
    if (now - lastReply > LOCKED_REPLY_COOLDOWN_MS) {
    lockedReplyCooldown.set(id, now);
      console.log(
        `[playerLock] ${id} tried to add but is locked in match ${matchId}`
      );
      try {
        await message.reply(
          `🚫 You’re currently locked in **Match ${matchId}**. Wait until it finishes before re-adding.`
        );
      } catch {}
    }
  return;
  }

	// Stop overfilling
	if (state.queue.length >= (state.MAX_PLAYERS || 8)) {
	  //return message.reply(`🚨 Queue is already full (${state.MAX_PLAYERS || 8} players).`);
	  return;
	}

// If player is already ghost-banned, notify them again and block add
if (state.ghostBans && state.ghostBans[id]) {
  const gb = state.ghostBans[id];
  console.log(`[ghost-ban] ${id} attempted to add but is ghosted`);

  try {
    await message.author.send(
      `🚫 You are still ghost-banned and must sit out **${gb.gamesRemaining} more game${gb.gamesRemaining === 1 ? "" : "s"}**.\n` +
      `📝 Reason: ${gb.reason || "unspecified"}`
    );
  } catch (err) {
    console.warn(`[ghost-ban] Failed to DM ghosted user ${id}:`, err.message);
  }
  return; // stop them from being added
}

// If player is banned, notify them and block add
const ban = banStore?.getBan(id);
if (ban) {
  state.ghostBans = state.ghostBans || {};
  state.ghostBans[id] = ban;

  console.log(`[ghost-ban] ${id} attempted to add but is ghosted`);

  try {
    await message.author.send(
      `⏳ You are still banned for **${ban.gamesRemaining} more game(s)**.\nReason: ${ban.reason || "unspecified"}`
    );
  } catch {}
  return; // still banned, don’t add them
}

    const name = message.member?.displayName || message.author.username;
    let entry = state.queue.find(p => p.id === id);
    if (!entry) {
      entry = { id, name, lastSeenAt: Date.now() };
      state.queue.push(entry);
    } else {
      entry.lastSeenAt = Date.now();
    }

    // mark ADL voters + register vote
    if (isAdl) {
      entry.adlVote = true;
      try { adl.vote(String(id)); } catch {}
    }

    // force Elo lookup so correct rank is shown
    try { elo.getRating(id, name, { createIfMissing: true }); } catch {}

    await postQueueBoard(message.channel, state, elo, privacy);
    try { await refreshBotName(message.client, state); } catch {}
    try { reg.persistQueueSoon?.(); } catch {}

    await maybeStartAutoFullVote(message, state);
  };

    const remove = async (message) => {
  if (String(message.channel?.id) !== String(config.channels.pickup)) return;
  const id = message.author.id;

  // block removes from people not actually in queue
  if (!state.queue.some(p => String(p.id) === String(id))) {
    console.log(`[queue] Ignored remove from non-queued user ${id}`);
    return;
  }

  // Handle active vote removal cleanly
  if (state.isVotingInProgress || state.vote) {
    try {
      const reason = `Player <@${id}> left during vote. Requeuing remaining players.`;
      if (state.vote?.cancelVote) {
        await state.vote.cancelVote(reason, id);
      } else {
        // Vote startup is still awaiting its first Discord message. Cancel
        // the in-flight runner and remove the player from both rosters.
        state.voteStartToken = null;
        state.queue = state.queue.filter(p => String(p.id) !== String(id));
        if (Array.isArray(state.queueSnapshot)) {
          state.queueSnapshot = state.queueSnapshot.filter(p => String(p.id) !== String(id));
        }
        state.vote = null;
        state.isVotingInProgress = false;
        state.pendingTeam1Starts = null;
        state.voteLock = false;
        state.isVoteStarting = false;
        await message.channel.send(`⚠️ ${reason} Vote canceled.`);
      }

      await postQueueBoard(message.channel, state, elo, privacy);
      try { await refreshBotName(message.client, state); } catch {}
      try { reg.persistQueueSoon?.(); } catch {}
      console.log(`[queue] ${message.author.tag} left mid-vote — vote canceled, removed, and queue updated.`);
      return;
    } catch (err) {
      console.error("[queue] Failed to handle mid-vote leave:", err);
    }
  }

    // Normal remove logic
    try { adl.unvote(String(id)); } catch {}

    const before = state.queue.length;
    state.queue = state.queue.filter(p => p.id !== id);

    if (state.queue.length !== before) {
      await postQueueBoard(message.channel, state, elo, privacy);
      try { await refreshBotName(message.client, state); } catch {}
      try { reg.persistQueueSoon?.(); } catch {}
      console.log(`[queue] ${message.author.tag} removed normally (${state.queue.length} remaining).`);
    }
  };

	const status = async (message) => {
	  if (String(message.channel?.id) !== String(config.channels.pickup)) return;

	  const now = Date.now();
	  if (now - lastStatusUsedAt < STATUS_COOLDOWN_MS) {
		return; // 🚫 silent cooldown
	  }

	  lastStatusUsedAt = now;
	  await postQueueBoard(message.channel, state, elo, privacy);
	};

  const clear = async (message) => {
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;
    if (!isAdmin(message)) return message.channel.send("❌ You don’t have permission to use `!clear`.");

    const h = state.vote;
    if (h) {
      try {
        h.cancelled = true;
        h.notifyTimers?.forEach(clearAnyTimer);
        clearAnyTimer(h.endTimer);
        clearAnyTimer(h.tickTimer);
        await h.message.edit({ components: [] }).catch(() => {});
        h.collector?.stop("cancelled");
      } catch {}
    }

    state.vote = null;
    state.queueSnapshot = null;
    state.serverWinner = null;
    state.pendingTeam1Starts = null;
    state.isVotingInProgress = false;
    state.queue = [];

    try { adl.clearAll?.(); } catch {}
    await message.channel.send("🧹 Queue and any active vote cleared.");
    await postQueueBoard(message.channel, state, elo, privacy);

    try { await refreshBotName(message.client, state); } catch {}
    try { reg.persistQueueSoon?.(); } catch {}
  };

  const addplayer = async (message) => {
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;
    if (!isAdmin(message)) return;
	const target = message.mentions?.users?.first();
	if (!target) return message.channel.send("Usage: `!addplayer @user`");

	if (state.isVotingInProgress || state.vote) {
	  return message.channel.send(
		"🚫 Cannot add players while a vote is in progress."
	  );
	}

	if (state.queue.length >= (state.MAX_PLAYERS || 8)) {
	  return message.channel.send(
		`🚨 Queue is already full (${state.MAX_PLAYERS || 8} players).`
	  );
	}

    const ban = banStore?.getBan(target.id);
    if (ban) {
      state.ghostBans = state.ghostBans || {};
      state.ghostBans[target.id] = true;

      try {
        await target.send(
          `⏳ You are still banned for **${ban.gamesRemaining} more game(s)**.\nReason: ${ban.reason || "unspecified"}`
        );
      } catch {}

      return; // still banned
    }

    let display = target.username;
    try {
      const m = await message.guild.members.fetch(target.id).catch(() => null);
      if (m?.displayName) display = m.displayName;
    } catch {}
    if (!state.queue.some(p => p.id === target.id)) {
      state.queue.push({ id: target.id, name: display, lastSeenAt: now() });
      try { elo.getRating(target.id, display, { createIfMissing: true }); } catch {}
    }
    await postQueueBoard(message.channel, state, elo, privacy);
    try { await refreshBotName(message.client, state); } catch {}
    try { reg.persistQueueSoon?.(); } catch {}
  };

  const removeplayer = async (message) => {
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;
    if (!isAdmin(message)) return;
    const target = message.mentions?.users?.first();
    if (!target) return message.channel.send("Usage: `!removeplayer @user`");
    try { adl.unvote(String(target.id)); } catch {}

    const before = state.queue.length;
    state.queue = state.queue.filter(p => p.id !== target.id);
    if (state.queue.length !== before) {
      await postQueueBoard(message.channel, state, elo, privacy);
      try { await refreshBotName(message.client, state); } catch {}
      try { reg.persistQueueSoon?.(); } catch {}
    } else {
      await message.channel.send(`User <@${target.id}> was not in the queue.`);
    }
  };

  const filltest = async (message, args) => {
    if (String(message.channel?.id) !== String(config.channels.pickup)) return;
    if (!isAdmin(message)) return;

    const n = Math.max(
      1,
      Math.min(parseInt(args[0], 10) || (state.MAX_PLAYERS || 8), 32)
    );

    while (state.queue.length < n) {
      const fakeId = `test_${Math.random().toString(36).slice(2, 8)}`;
      const fakeName = `Test#${state.queue.length + 1}`;

      state.queue.push({ id: fakeId, name: fakeName, lastSeenAt: now() });

      // 🟢 auto-vote them into ADL
      //try {
     //   adl.vote(String(fakeId));
     //   console.log(`[filltest] Added ${fakeName} (${fakeId}) with ADL vote`);
    //  } catch (e) {
    //    console.error(`[filltest] Failed ADL vote for ${fakeId}:`, e);
    //  }
    }

    await postQueueBoard(message.channel, state, elo, privacy);
    try { await refreshBotName(message.client, state); } catch {}
    try { reg.persistQueueSoon?.(); } catch {}
  };

	// Set Queue size or show current
	const setqueue = async (message, args) => {
	  if (String(message.channel?.id) !== String(config.channels.pickup)) return;
	  if (!isAdmin(message)) {
		return message.channel.send("❌ You don’t have permission to use `!setqueue`.");
	  }

	  // If no argument, just report the current queue size
	  if (!args[0]) {
		return message.channel.send(
		  `📊 Current queue size: **${state.MAX_PLAYERS} players** (match size: ${state.MAX_PLAYERS/2}v${state.MAX_PLAYERS/2}).`
		);
	  }

	  const n = parseInt(args[0], 10);
	  if (!n || n < 2 || n > 32) {
		return message.channel.send("⚠️ Usage: `!setqueue <number>` (between 2 and 32).");
	  }

	  state.MAX_PLAYERS = n;
	  config.MAX_PLAYERS = n; // keep config in sync

	  await message.channel.send(`✅ Queue size set to **${n} players** (match size: ${n/2}v${n/2}).`);

	  try { await refreshBotName(message.client, state); } catch {}
	  try { reg.persistQueueSoon?.(); } catch {}
	};

  // persist hook
  reg.persistQueueSoon = (global.persistQueueSoon || (() => {}));

  // commands
  reg.set("add", (msg) => add(msg, false));
  reg.set("remove", remove);
  reg.set("status", status);
  reg.set("clear", clear);
  reg.set("addplayer", addplayer);
  reg.set("removeplayer", removeplayer);
  reg.set("filltest", filltest);
  reg.set("setqueue", setqueue);
  reg.set("queue", setqueue);


// aliases
reg.set("++", (msg) => add(msg, false));
reg.set("add", (msg) => add(msg, false));
reg.set("--", remove);
reg.set("addadl", (msg) => add(msg, true));
reg.set("++adl", (msg) => add(msg, true));
reg.set("**", (msg) => add(msg, true));

  const sendHldsMessage = async (evt, text) => {
    if (!evt?.serverKey || typeof runRconCommand !== "function") {
      console.warn(
        `[hlds queue] Cannot send RCON response; unknown server for ${evt?.from || "unknown source"}`
      );
      return;
    }

    try {
      await runRconCommand(evt.serverKey, `say "[Queue] ${safeRconText(text)}"`);
    } catch (err) {
      console.warn(`[hlds queue] RCON message failed for ${evt.serverKey}:`, err.message);
    }
  };

  const pickupChannel = async () => {
    const realClient = reg.client || client;
    if (!realClient) return null;
    const channel = await realClient.channels.fetch(config.channels.pickup);
    return channel?.isTextBased?.() ? channel : null;
  };

  const removeHldsEntry = async (entry, reason) => {
    const id = String(entry.id);
    try { adl.unvote(id); } catch {}

    if (state.isVotingInProgress && state.vote?.cancelVote) {
      await state.vote.cancelVote(reason, id);
    } else {
      state.queue = state.queue.filter(p => String(p.id) !== id);
      if (Array.isArray(state.queueSnapshot)) {
        state.queueSnapshot = state.queueSnapshot.filter(p => String(p.id) !== id);
      }
    }

    try { reg.persistQueueSoon?.(); } catch {}

    const channel = await pickupChannel().catch(() => null);
    if (channel) {
      await channel.send(reason);
      await postQueueBoard(channel, state, elo, privacy);
      try { await refreshBotName(reg.client || client, state); } catch {}
    }
  };

  reg.handleHldsQueueEvent = async (evt) => {
    if (evt?.type === "disconnect") {
      const steamId = String(evt.steamid || "").trim().toUpperCase();
      const entry = state.queue.find(p =>
        p.queueOrigin === "hlds" &&
        String(p.steamId || "").toUpperCase() === steamId &&
        (
          (p.sourceServerKey && evt.serverKey && p.sourceServerKey === evt.serverKey) ||
          (!p.sourceServerKey && p.sourceServerIp === evt.from)
        )
      );

      if (!entry) return false;

      await removeHldsEntry(
        entry,
        `⚠️ <@${entry.id}> disconnected from ${entry.sourceServerKey || "the game server"} and was removed from the queue.`
      );
      return false;
    }

    if (evt?.type !== "say") return false;
    const command = parseHldsQueueCommand(evt.text);
    if (!command) return false;

    if (!evt.serverKey) {
      console.warn(
        `[hlds queue] Ignored ${evt.text} from unconfigured source ${evt.from}:${evt.sourcePort || "?"}`
      );
      return true;
    }

    const steamId = String(evt.steamid || "").trim().toUpperCase();
    let links;
    try {
      links = await steamLinks?.getDiscordBySteam(steamId);
    } catch (err) {
      console.error(`[hlds queue] Steam link lookup failed for ${steamId}:`, err);
      await sendHldsMessage(evt, `${evt.player}: account lookup failed; please try again.`);
      return true;
    }

    const discordIds = [...new Set(
      (links || []).map(link => String(link.discord_id || "").trim()).filter(Boolean)
    )];

    if (discordIds.length !== 1) {
      const reason = discordIds.length
        ? "multiple Discord links found; contact an admin."
        : "link Steam to Discord first.";
      await sendHldsMessage(evt, `${evt.player}: ${reason}`);
      return true;
    }

    const discordId = discordIds[0];
    const existing = state.queue.find(p => String(p.id) === discordId);

    if (command.action === "remove") {
      if (!existing) {
        await sendHldsMessage(evt, `${evt.player}: you are not in the queue.`);
        return true;
      }

      await removeHldsEntry(
        existing,
        `<@${discordId}> left the queue from ${evt.serverKey}.`
      );
      await sendHldsMessage(evt, `${evt.player}: removed from the queue.`);
      return true;
    }

    if (state.lockedPlayers?.has(discordId)) {
      await sendHldsMessage(evt, `${evt.player}: you are already locked into an active match.`);
      return true;
    }

    if (state.bannedUsers?.has(discordId) || state.ghostBans?.[discordId] || banStore?.getBan(discordId)) {
      await sendHldsMessage(evt, `${evt.player}: you cannot join the queue right now.`);
      return true;
    }

    if (!existing && state.queue.length >= (state.MAX_PLAYERS || 8)) {
      await sendHldsMessage(evt, `${evt.player}: the queue is already full.`);
      return true;
    }

    const channel = await pickupChannel().catch(() => null);
    if (!channel) {
      await sendHldsMessage(evt, `${evt.player}: the Discord pickup channel is unavailable.`);
      return true;
    }

    let member = null;
    try {
      member = await channel.guild?.members?.fetch(discordId);
    } catch {}
    if (!member) {
      await sendHldsMessage(
        evt,
        `${evt.player}: your Discord link was found, but you must be in the Discord server to queue.`
      );
      return true;
    }

    const name = member.displayName || evt.player || `Player#${discordId.slice(-4)}`;
    const entry = existing || { id: discordId, name, lastSeenAt: Date.now() };
    if (!existing) state.queue.push(entry);

    entry.name = name;
    entry.lastSeenAt = Date.now();
    entry.queueOrigin = "hlds";
    entry.sourceServerKey = evt.serverKey;
    entry.sourceServerIp = evt.from;
    entry.steamId = steamId;

    if (command.adl) {
      entry.adlVote = true;
      try { adl.vote(discordId); } catch {}
    }

    try { elo.getRating(discordId, name, { createIfMissing: true }); } catch {}
    try { reg.persistQueueSoon?.(); } catch {}

    if (!existing) {
      await channel.send(`<@${discordId}> joined the queue from ${evt.serverKey}.`);
    }
    await postQueueBoard(channel, state, elo, privacy);
    try { await refreshBotName(reg.client || client, state); } catch {}

    await sendHldsMessage(
      evt,
      `${evt.player}: added to the ${command.adl ? "ADL " : ""}queue (${state.queue.length}/${state.MAX_PLAYERS || 8}).`
    );

    const syntheticMessage = {
      channel,
      client: reg.client || client,
      guild: channel.guild,
      member,
      author: member.user,
      reply: (...args) => channel.send(...args),
    };
    await maybeStartAutoFullVote(syntheticMessage, state);
    return true;
  };

/* ---------------- scheduled cleanup ---------------- */
setInterval(async () => {
  // 🚫 Do not AFK kick anyone while a vote is already in progress
  if (state.isVotingInProgress || state.vote) {
    return;
  }

  const idleMin = getNumber(settings, "queue:idle_min", 120);
  const ts = Date.now();
  const idleMs = idleMin * 60 * 1000;

  // Add 60s buffer so fresh re-adds don’t get kicked
  const expired = state.queue.filter(
    p =>
      p.lastSeenAt &&
      (ts - p.lastSeenAt) >= (idleMs + 60_000) &&
      (!p.lastAfkKick || (ts - p.lastAfkKick) > 300_000)
  );

  if (expired.length > 0) {
    const kickedIds = new Set(expired.map(p => String(p.id)));

    // Remove ADL votes for anyone being AFK kicked
    for (const p of expired) {
      try {
        adl.unvote(String(p.id));
        p.adlVote = false;
        console.log(`[queue cleanup] Removed ADL vote for AFK kicked player ${p.id}`);
      } catch (e) {
        console.warn(`[queue cleanup] Failed to remove ADL vote for ${p.id}:`, e.message);
      }
    }

    // Mark kick time
    for (const p of expired) {
      p.lastAfkKick = ts;
    }

    // Actually remove them
    state.queue = state.queue.filter(p => !kickedIds.has(String(p.id)));

    try {
      const realClient = client || reg.client;
      if (!realClient) {
        console.error("[queue cleanup] No Discord client available");
        return;
      }

      const chan = await realClient.channels.fetch(config.channels.pickup);
      if (chan?.isTextBased()) {
        const kickedMentions = expired.map(p => `<@${p.id}>`).join(", ");
        await chan.send(
          `⏰ Removed ${kickedMentions} — AFK too long (${idleMin} min). Please re-add if you want to play.`
        );
        await postQueueBoard(chan, state, elo, privacy);
        await refreshBotName(realClient, state);
      }
    } catch (e) {
      console.error("[queue cleanup] failed:", e);
    }

    // robustly call whichever persist function exists (reg or global)
    try {
      const persist =
        reg && typeof reg.persistQueueSoon === "function"
          ? reg.persistQueueSoon
          : global.persistQueueSoon;

      if (typeof persist === "function") persist();
    } catch (err) {
      console.warn("[queue cleanup] persist failed", err);
    }
  }
}, 60_000).unref();

}

async function addPlayerToQueue(message, { state, config, elo, banStore, settings, reg, privacy }) {
  if (String(message.channel?.id) !== String(config.channels.pickup)) return null;
  const id = message.author.id;

  // 🚫 Enforce bans
  const ban = banStore?.getBan(id);
  if (ban) return null;

  const name = message.member?.displayName || message.author.username;
  let entry = state.queue.find(p => p.id === id);
  if (!entry) {
    entry = { id, name, lastSeenAt: Date.now() };
    state.queue.push(entry);
  } else {
    entry.lastSeenAt = Date.now();
  }

  // 👇 Ensure Elo rank is ready
  try { elo.getRating(id, name, { createIfMissing: true }); } catch {}

  await postQueueBoard(message.channel, state, elo, privacy);
  try { await refreshBotName(message.client, state); } catch {}
  try { reg.persistQueueSoon?.(); } catch {}

  return entry; // 👈 return so addadl.js can tag adlVote
}

module.exports = {
  register,
  postQueueBoard,
  addPlayerToQueue,
  maybeStartAutoFullVote,
  notifyHldsVoteStarted,
  parseHldsQueueCommand,
  safeRconText,
};
