// lib/vote.js (patched + first-vote bias + visible RNG + leave cleanup)
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  isRealDiscordId,
  mention,
  mirvLabel,
} = require("./util");
const { appendKickedPlayers } = require("./kickedLog");

const NUM_EMOJI = ["", "1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const NUM_SHORT = ["", ":one:", ":two:", ":three:", ":four:", ":five:", ":six:", ":seven:", ":eight:", ":nine:"];

function emojiFor(idx) { return NUM_EMOJI[idx] || String(idx); }
function fmtVotes(n)    { return `${n} vote${n === 1 ? "" : "s"}`; }
function pickOptions(items, max) { return items.slice(0, max); }

// 🧩 helper: fully remove a player from live queue and snapshot
function removePlayerFromQueue(state, userId) {
  if (!state || !userId) return;
  const before = state.queue?.length || 0;

  state.queue = (state.queue || []).filter(p => String(p.id) !== String(userId));
  if (state.queueSnapshot) {
    state.queueSnapshot = state.queueSnapshot.filter(p => String(p.id) !== String(userId));
  }

  if (before !== (state.queue?.length || 0)) {
    console.log(`[vote.js] Removed player ${userId} from queue/snapshot`);
  }
}

async function startVote(state, message, cfg) {
  const duration = Math.max(10, Math.min(cfg.duration || 60, 180));
  const requestedMaxSelections = Number(cfg.maxSelectionsPerUser);
  const maxSelectionsPerUser =
    Number.isFinite(requestedMaxSelections) && requestedMaxSelections >= 1
      ? Math.floor(requestedMaxSelections)
      : 1;
	// filter out dummy "test_" users from eligibility list
	const eligibleRaw =
	  (state.queueSnapshot?.map(p => String(p.id)) ||
	   state.queue.slice(0, state.MAX_PLAYERS).map(p => String(p.id)));
	const eligible = eligibleRaw.filter(uid => !uid.startsWith("test_"));


  const opts = pickOptions(cfg.options || [], state.MAX_BUTTONS || 9);

  const handle = {
    message: null,
    cancelled: false,
    type: cfg.title || "Vote",
    kind: cfg.kind || "server",
    options: opts,
    eligible,
    counts: new Map(opts.map(o => [o.id, 0])),
    votersByOption: new Map(opts.map(o => [o.id, []])),
    votedByUser: new Map(),
    notifyTimers: [],
    endTimer: null,
    collector: null,
    endsAt: Date.now() + duration * 1000,
    showVoters: !!cfg.showVoters,
    maxSelectionsPerUser,
  };

  // Install cancellation before any awaited Discord operation. A player can
  // leave while the initial vote message is still being sent.
  handle.cancelVote = async function(reason, leaverId) {
    if (handle.cancelled) return;

    if (leaverId && !state.queue.some(p => String(p.id) === String(leaverId))) {
      console.log(`[vote.js] Ignored cancelVote from non-queued user ${leaverId}`);
      return;
    }

    handle.cancelled = true;
    handle.cancelReason = reason || "";
    try {
      handle.notifyTimers.forEach(clearTimeout);
      clearTimeout(handle.endTimer);
      handle.collector?.stop("cancelled");
    } catch {}

    try {
      if (handle.message) {
        await handle.message.edit({
          content: `⚠️ Vote canceled${reason ? ` — ${reason}` : ""}`,
          components: []
        }).catch(() => {});
      }
    } catch (e) {
      console.error("[vote.js cancelVote edit error]", e);
    }

    if (leaverId) removePlayerFromQueue(state, leaverId);

    state.vote = null;
    state.isVotingInProgress = false;
    state.pendingTeam1Starts = null;
    console.log(`[vote.js] Vote canceled${reason ? `: ${reason}` : ""}`);
  };

  // Publish the handle before the first Discord send. Vote startup performs
  // awaits, and a player can leave during that window; removals must still be
  // able to cancel this vote instead of falling through to normal removal.
  state.vote = handle;
  state.isVotingInProgress = true;

  function buildDescription() {
    const lines = [];
    if (handle.kind === "map") {
      lines.push(
        handle.maxSelectionsPerUser === 1
          ? "Vote for one map."
          : `Select up to ${handle.maxSelectionsPerUser} maps. Click again to remove a selection.`
      );
    }
    lines.push("\u200B");

    handle.options.forEach((o, i) => {
      const idx = i + 1;
      const head =
        handle.kind === "map"
          ? `${NUM_SHORT[idx] || `${idx}.`} - ${o.name} - ${mirvLabel(o.mirv)}`
          : `${NUM_SHORT[idx] || `${idx}.`} - ${o.name}`;
      lines.push(head);

      const count = handle.counts.get(o.id) || 0;
      const voters = handle.votersByOption.get(o.id) || [];
      if (handle.showVoters && voters.length) {
        const boldNames = voters.map(v => `**${v}**`).join(", ");
        lines.push(`(${boldNames}) - ${fmtVotes(count)}`);
      } else {
        lines.push(`${fmtVotes(count)}`);
      }

      if (i !== handle.options.length - 1) lines.push("\u200B");
    });

    const waiting = handle.eligible.filter(uid => {
      if (!isRealDiscordId(uid)) return false;
      if (uid.startsWith("test_")) return false;
      return !handle.votedByUser.has(uid);
    });

    if (!waiting.length) {
      lines.push("");
      lines.push("✅ All eligible votes are in.");
    }

    return lines.join("\n");
  }

  function buildEmbed() {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${handle.type}`)
      .setDescription(buildDescription());
  }

  function buildButtons() {
    const row = new ActionRowBuilder();
    handle.options.forEach((o, i) => {
      const idx = i + 1;
      const label = `${emojiFor(idx)} ${o.name}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_${o.id}`)
          .setStyle(ButtonStyle.Primary)
          .setLabel(label)
      );
    });
    return [row];
  }

  // 📨 send main vote embed
  const msg = await message.channel.send({
    embeds: [buildEmbed()],
    components: buildButtons()
  });
  handle.message = msg;

  if (handle.cancelled || state.vote !== handle) {
    if (handle.cancelled) {
      try {
        await msg.edit({
          content: `⚠️ Vote canceled${handle.cancelReason ? ` — ${handle.cancelReason}` : ""}`,
          components: []
        });
      } catch {}
    }
    return;
  }

  // ping voters separately so pings aren’t suppressed
  if (handle.eligible?.length) {
    const mentions = handle.eligible
      .filter(isRealDiscordId)
      .map(id => `<@${id}>`)
      .join(" ");
    await message.channel.send({
      content: `${mentions} — vote is now live!`,
      allowedMentions: { parse: ["users"] }
    });
  }

  if (handle.cancelled || state.vote !== handle) return;

  const collector = msg.createMessageComponentCollector({ time: duration * 1000 });
  handle.collector = collector;

  // ======================= VOTE HANDLER =======================
  collector.on("collect", async (interaction) => {
    const uid = String(interaction.user.id);
    if (!handle.eligible.includes(uid)) {
      try { await interaction.deferUpdate(); } catch {}
      return;
    }

    const newChoice = (interaction.customId || "").replace(/^vote_/, "");
    if (!handle.counts.has(newChoice)) {
      try { await interaction.deferUpdate(); } catch {}
      return;
    }

    const disp =
      interaction.member?.displayName ||
      interaction.user?.username ||
      interaction.user?.tag || "Unknown";

    if (handle.maxSelectionsPerUser === 1) {
      const prevChoice = handle.votedByUser.get(uid);
      if (prevChoice && prevChoice !== newChoice) {
        handle.counts.set(prevChoice, Math.max(0, (handle.counts.get(prevChoice) || 0) - 1));
        const prevArr = handle.votersByOption.get(prevChoice) || [];
        const pi = prevArr.indexOf(disp);
        if (pi >= 0) prevArr.splice(pi, 1);
        handle.votersByOption.set(prevChoice, prevArr);
      }

      if (prevChoice !== newChoice) {
        handle.votedByUser.set(uid, newChoice);
        handle.counts.set(newChoice, (handle.counts.get(newChoice) || 0) + 1);
        const arr = handle.votersByOption.get(newChoice) || [];
        arr.push(disp);
        handle.votersByOption.set(newChoice, arr);
      }
    } else {
      const selections = new Set(handle.votedByUser.get(uid) || []);

      if (selections.has(newChoice)) {
        selections.delete(newChoice);
        handle.counts.set(newChoice, Math.max(0, (handle.counts.get(newChoice) || 0) - 1));
        const arr = handle.votersByOption.get(newChoice) || [];
        const index = arr.indexOf(disp);
        if (index >= 0) arr.splice(index, 1);
        handle.votersByOption.set(newChoice, arr);
      } else {
        if (selections.size >= handle.maxSelectionsPerUser) {
          try { await interaction.deferUpdate(); } catch {}
          return;
        }

        selections.add(newChoice);
        handle.counts.set(newChoice, (handle.counts.get(newChoice) || 0) + 1);
        const arr = handle.votersByOption.get(newChoice) || [];
        arr.push(disp);
        handle.votersByOption.set(newChoice, arr);
      }

      if (selections.size > 0) handle.votedByUser.set(uid, selections);
      else handle.votedByUser.delete(uid);
    }

    try {
      await interaction.deferUpdate();
      const missing = handle.eligible.filter(uid => {
        if (!isRealDiscordId(uid)) return false;
        if (uid.startsWith("test_")) return false;
        return !handle.votedByUser.has(uid);
      });
      const status = missing.length > 0
        ? null
        : "✅ **All eligible votes are in!**";
      await handle.message.edit({
        content: status,
        embeds: [buildEmbed()],
      });
    } catch (e) {
      console.error("[vote.js update/ping error]", e);
    }

    try {
      await cfg.onVote?.({
        eligible: handle.eligible.slice(),
        voted: new Set(handle.votedByUser.keys()),
        voteHandle: handle,
      });
    } catch (e) {
      console.error("[vote.js onVote error]", e);
    }
  });

	// ======================================================
	// 🎰 Fancy Map Spinner (reused from spintest.js)
	// ======================================================
	async function runFancySpinner(message, maps) {
	  console.log("[vote.js] 🎰 Starting fancy spinner...");

	  const winner = maps[Math.floor(Math.random() * maps.length)];
	  const winIndex = maps.indexOf(winner) + 1;
	  const reelNum = winIndex > 0 ? winIndex : 1;
	  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	  let previousFrame = [];
	  const spinningFrame = () => {
		if (maps.length <= 1) return [reelNum, reelNum, reelNum];

		let frame;
		do {
		  frame = Array.from(
			{ length: 3 },
			() => Math.floor(Math.random() * maps.length) + 1
		  );
		} while (
		  frame.every((value) => value === frame[0]) ||
		  frame.every((value, index) => value === previousFrame[index])
		);

		previousFrame = frame;
		return frame;
	  };

		const box = (a, b, c) =>
		  "```\n" +
		  "╔═════════════════════╗\n" +
		  "║ ┌─────┬─────┬─────┐ ║\n" +
		  `║ │  ${a}  │  ${b}  │  ${c}  │ ║\n` +
		  "║ └─────┴─────┴─────┘ ║\n" +
		  "╚═════════════════════╝\n" +
		  "                                           \n" +
		  "```\n" +
		  maps.map((m, i) => `${i + 1}. ${m.name || m}`).join(" | ");

	  // Keep every reel moving until the final reveal. With only two choices,
	  // locking even one reel early would immediately give away the winner.
	  // Three total edits also stay below Discord's per-message edit bucket.
	  const spinMsg = await message.channel.send({
		embeds: [
		  new EmbedBuilder()
			.setColor(0x5865f2)
			.setDescription(box(...spinningFrame()))
		],
	  });

	  await pause(140);
	  await spinMsg.edit({
		embeds: [
		  new EmbedBuilder()
			.setColor(0xed4245)
			.setDescription(box(...spinningFrame()))
		],
	  });

	  await pause(180);
	  await spinMsg.edit({
		embeds: [
		  new EmbedBuilder()
			.setColor(0x5865f2)
			.setDescription(box(...spinningFrame()))
		],
	  });

	  await pause(260);

	// build label + emoji for clarity
	const labelIcon =
	  cfg?.kind === "server" ? "🖥️ **Winning Server:**" :
	  cfg?.kind === "map"    ? "🗺️ **Winning Map:**" :
							   "🏆 **Winner:**";

	const winnerLabel = winner.name?.toUpperCase?.() || winner.toUpperCase?.() || String(winner).toUpperCase();

	// 🧩 simplified final embed — trimmed down version
	const finalEmbed = new EmbedBuilder()
	  .setColor(0x57f287)
	  .setDescription(
		box(reelNum, reelNum, reelNum) +
		`\n${labelIcon} ${winnerLabel}`
	  );

	await spinMsg.edit({ embeds: [finalEmbed] });
	console.log(`[vote.js] ✅ Final ${cfg?.kind} winner: ${winnerLabel}`);
	return winner;

	}

  // ======================= END HANDLER =======================
  collector.on("end", async () => {
    try {
      await handle.message.edit({ components: [] });
    } catch {}

    if (handle.cancelled) return;

    if (handle.kind === "server") {
      const missing = handle.eligible.filter(uid => !handle.votedByUser.has(uid));
      const realMissing = missing.filter(uid => !uid.startsWith("test_"));

      if (realMissing.length > 0) {
        const names = realMissing.map(mention).join(", ");
        console.log(`[vote.js] Server vote incomplete — kicking: ${names}`);

        try {
          const entry = appendKickedPlayers(realMissing, message);
          console.log(`[KICKED LOG] Added ${entry.names} @ ${entry.timestamp}`);
        } catch (err) {
          console.error("[KICKED LOG] Failed to write kicked.json:", err);
        }

        await message.channel.send({
          content:
            `⚠️ **Server vote failed** — missing votes from: ${names}\n`,
        });

        realMissing.forEach(uid => removePlayerFromQueue(state, uid));

        // ✅ NEW: refresh queue board
        try {
          // ✅ use the queue.js module instead
		const { postQueueBoard } = require("../commands/queue");
		const config = require("../config"); // needed for channel ID
		const pickupChan = await message.client.channels.fetch(config.channels.pickup);
		if (pickupChan?.isTextBased()) {
		  await postQueueBoard(pickupChan, state, state.elo, state.privacy);
		}

        } catch (e) {
          console.error("[vote.js] failed to refresh queue board after kicks:", e);
        }

        console.log("[vote.js] Vote flow halted — queue no longer full after kick(s).");
        state.vote = null;
        state.isVotingInProgress = false;
        state.pendingTeam1Starts = null;
        return; // ❌ stop here (no tiebreaker or spinner)
      } else {
        console.log("[vote.js] Only test users were missing votes — skipping kicks.");
      }
    }

    // continue to tiebreaker logic (map or server, if all voted)
    let bestCount = Math.max(...handle.options.map(o => handle.counts.get(o.id) || 0));
    if (bestCount <= 0) {
      console.warn("[vote.js] No valid votes received — cannot finalize match.");
      await message.channel.send("⚠️ No valid votes received — match cannot be finalized.");
      state.vote = null;
      state.isVotingInProgress = false;
      state.pendingTeam1Starts = null;
      return;
    }

    const topOptions = handle.options.filter(o => (handle.counts.get(o.id) || 0) === bestCount);
    let best = null;

    if (topOptions.length > 1) {
      // 🎲 Tie → run fancy spinner (it already shows the winner)
      const names = topOptions.map(o => o.name);
      await message.channel.send(`🎲 Tiebreaker between ${names.map(n => `**${n}**`).join(" vs ")}...`);

      const spinnerOptions = topOptions.flatMap(o => {
		  const isNewMaps =
			handle.kind === "map" && /new\s*maps?/i.test(o.name || "");

		  return isNewMaps ? [o, o] : [o];
		});

		console.log(
		  "[vote.js] weighted tiebreaker:",
		  spinnerOptions.map(o => o.name)
		);

		const winner = await runFancySpinner(message, spinnerOptions, { kind: handle.kind });
      best = winner;

      // no extra “Map chosen” line — spinner already showed it
      state.vote.map = best.name;
      console.log(`[vote.js] 🌀 Spinner result: ${best.name}`);
    } else {
      // ✅ one clear winner — no spinner
      best = topOptions[0];
      console.log(`[vote.js] ✅ Direct winner: ${best.name}`);

      let announcement = null;
      if (handle.kind === "server") {
        announcement = `🖥️ Server chosen: **${best.name}**`;
      } else if (!/new\s*maps?/i.test(best.name)) {
        announcement = `🗺️ Map chosen: **${best.name}**`;
      } else {
        announcement = `🆕 **New Maps** selected — loading second vote...`;
      }

      // Winner announcements are informational. Do not let a delayed or failed
      // Discord send block the server-vote -> map-vote transition.
      if (announcement) {
        message.channel.send(announcement).catch(e => {
          console.error(`[vote.js] ${handle.kind} winner announcement failed:`, e);
        });
      }

      if (handle.kind === "map" && /new\s*maps?/i.test(best.name)) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    handle.notifyTimers.forEach(id => { try { clearTimeout(id); } catch {} });
    try { clearTimeout(handle.endTimer); } catch {}
    state.vote = null;
    state.isVotingInProgress = false;

    const payload = {
      winner: best,
      counts: handle.counts,
      options: handle.options,
      eligible: handle.eligible.slice(),
      voted: new Set(handle.votedByUser.keys()),
    };
    console.log(`[vote.js] invoking ${handle.kind} vote onFinish`);
    try {
      await cfg.onFinish?.(payload);
      console.log(`[vote.js] ${handle.kind} vote onFinish completed`);
    } catch (e) {
      console.error(`[vote.js] ${handle.kind} vote onFinish failed:`, e);
    }
  });

  const channelReminderSeconds = new Set([45, 30, 10, 5]);
  const dmReminderSeconds = new Set([30, 15, 10, 5]);

  [45, 30, 15, 10, 5].filter(t => t < duration).forEach(t => {
    const id = setTimeout(() => {
      if (handle.cancelled) return;
      const remaining = handle.eligible.filter(uid => {
        if (!isRealDiscordId(uid)) return false;
        if (uid.startsWith("test_")) return false;
        return !handle.votedByUser.has(uid);
      });

      if (channelReminderSeconds.has(t) && remaining.length) {
        const mentions = remaining.map(mention).join(", ");
        handle.message.reply({
          content: `⏰ **${t}s left** — please vote: ${mentions}`,
          allowedMentions: { parse: ["users"] }
        }).catch(() => {});
      }

      if (dmReminderSeconds.has(t) && remaining.length) {
        Promise.allSettled(remaining.map(async uid => {
          try {
            const user = await handle.message.client?.users?.fetch(uid);
            if (!user) return;
            await user.send(
              `⏰ **${handle.type}** has **${t} seconds** left. ` +
              `Vote now in <#${message.channel.id}> before the timer ends.`
            );
          } catch (e) {
            console.warn(`[vote.js] vote reminder DM failed for ${uid}:`, e?.message || e);
          }
        })).catch(e => {
          console.error(`[vote.js] vote reminder DM batch failed at ${t}s:`, e);
        });
      }
    }, (duration - t) * 1000);
    handle.notifyTimers.push(id);
  });

  handle.endTimer = setTimeout(() => {
    try { collector.stop("timeout"); } catch {}
  }, duration * 1000);

}

module.exports = { startVote };
