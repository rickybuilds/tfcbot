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
  disableAllButtons,
} = require("./util");

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

    lines.push("");
    lines.push("**Waiting on**");
    if (waiting.length) lines.push(waiting.map(mention).join(", "));
    else lines.push("✅ All eligible votes are in.");

    const endUnix = Math.floor(handle.endsAt / 1000);
    lines.push("");
    lines.push(`⏰ Voting ends <t:${endUnix}:R>`);

    return lines.join("\n");
  }

  function buildEmbed() {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${handle.type}`)
      .setDescription(buildDescription())
      .setTimestamp();
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
      const mentions =
        missing.length > 0
          ? `⏳ **Waiting on:** ${missing.map(mention).join(" ")}`
          : "✅ **All eligible votes are in!**";
      await handle.message.edit({
        content: mentions,
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

  // ======================= CANCEL HANDLER =======================
  handle.cancelVote = async function(reason, leaverId) {
    if (handle.cancelled) return;

    // 🧩 NEW: Block outsiders from canceling / reverting votes
    if (leaverId && !state.queue.some(p => String(p.id) === String(leaverId))) {
      console.log(`[vote.js] Ignored cancelVote from non-queued user ${leaverId}`);
      return; // silently ignore
    }

    handle.cancelled = true;
    try {
      handle.notifyTimers.forEach(clearTimeout);
      clearTimeout(handle.endTimer);
      handle.collector?.stop("cancelled");
    } catch {}

    try {
      const disabled = disableAllButtons(handle.message);
      await handle.message.edit({
        content: `⚠️ Vote canceled${reason ? ` — ${reason}` : ""}`,
        components: disabled
      }).catch(() => {});
    } catch (e) {
      console.error("[vote.js cancelVote edit error]", e);
    }

    if (leaverId) removePlayerFromQueue(state, leaverId);

    state.vote = null;
    state.isVotingInProgress = false;
    console.log(`[vote.js] Vote canceled${reason ? `: ${reason}` : ""}`);
  };
	// ======================================================
	// 🎰 Fancy Map Spinner (reused from spintest.js)
	// ======================================================
	async function runFancySpinner(message, maps) {
	  const spinMsg = await message.channel.send("🎰 Initializing spinner...");
	  console.log("[vote.js] 🎰 Starting fancy spinner...");

	  const winner = maps[Math.floor(Math.random() * maps.length)];
	  let reels = ["?", "?", "?"];

	  const totalFrames = 9;
	  const delayStart = 65;
	  const delayEnd = 200;
	  const easeOut = (t) => delayStart + (delayEnd - delayStart) * (t ** 1.4);

		const slot = (v) =>
		  String(v)
			.padStart(3, " ")
			.padEnd(3, " ");


		const box = (a, b, c, mapList = "") =>
		  "```\n" +
		  "╔═════════════════════╗\n" +
		  "║ ┌─────┬─────┬─────┐ ║\n" +
		  `║ │  ${a}  │  ${b}  │  ${c}  │ ║\n` +
		  "║ └─────┴─────┴─────┘ ║\n" +
		  "╚═════════════════════╝\n" +
		  "                                           \n" +
		  "```\n" +
		  maps.map((m, i) => `${i + 1}. ${m.name || m}`).join(" | ");
		  ;

	  let colorToggle = false;
	  let lastEdit = 0;

	  for (let i = 0; i < totalFrames; i++) {
		const now = Date.now();
		const progress = i / (totalFrames - 1);
		const delay = easeOut(progress) + Math.random() * 40;

		reels = reels.map((r, idx) => {
		  const shouldSpin = i < totalFrames - (idx * 3 + 3);
		  return shouldSpin ? String(Math.ceil(Math.random() * maps.length)) : reels[idx];
		});

		if (now - lastEdit > 100) {
		  colorToggle = !colorToggle;
		  lastEdit = now;

		  const embed = new EmbedBuilder()
			.setColor(colorToggle ? 0xed4245 : 0x5865f2)
			.setDescription(box(reels[0], reels[1], reels[2]));
		  await spinMsg.edit({ embeds: [embed] });
		}

		await new Promise((r) => setTimeout(r, delay));
	  }

	// 🏁 final winner fix — ensure numeric reel matches option index
	const winIndex =
	  typeof winner === "string"
		? maps.findIndex(m => m === winner) + 1
		: maps.findIndex(m => (m.name || m) === (winner.name || winner)) + 1;

	// if something goes wrong, default to 1 instead of 0
	const reelNum = winIndex > 0 ? winIndex : 1;
	reels = [reelNum, reelNum, reelNum];

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
		box(reels[0], reels[1], reels[2]) +
		`\n${labelIcon} ${winnerLabel}`
	  );

	await spinMsg.edit({ embeds: [finalEmbed] });
	console.log(`[vote.js] ✅ Final ${cfg?.kind} winner: ${winnerLabel}`);
	return winner;

	}

  // ======================= END HANDLER =======================
  collector.on("end", async () => {
    try {
      const disabled = disableAllButtons(handle.message);
      await handle.message.edit({ components: disabled });
    } catch {}

    if (handle.cancelled) return;

    if (handle.kind === "server") {
      const missing = handle.eligible.filter(uid => !handle.votedByUser.has(uid));
      const realMissing = missing.filter(uid => !uid.startsWith("test_"));

      if (realMissing.length > 0) {
        const names = realMissing.map(mention).join(", ");
        console.log(`[vote.js] Server vote incomplete — kicking: ${names}`);

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

      if (handle.kind === "server") {
        await message.channel.send(`🖥️ Server chosen: **${best.name}**`);
      } else if (!/new\s*maps?/i.test(best.name)) {
        await message.channel.send(`🗺️ Map chosen: **${best.name}**`);
      } else {
        await message.channel.send(`🆕 **New Maps** selected — loading second vote...`);
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
    try { await cfg.onFinish?.(payload); } catch {}
  });

  [45, 30, 10, 5].filter(t => t < duration).forEach(t => {
    const id = setTimeout(() => {
      if (handle.cancelled) return;
      const remaining = handle.eligible.filter(uid => {
        if (!isRealDiscordId(uid)) return false;
        if (uid.startsWith("test_")) return false;
        return !handle.votedByUser.has(uid);
      });
      if (!remaining.length) return;
      const mentions = remaining.map(mention).join(", ");
      handle.message.reply({
        content: `⏰ **${t}s left** — please vote: ${mentions}`,
        allowedMentions: { parse: ["users"] }
      }).catch(() => {});
    }, (duration - t) * 1000);
    handle.notifyTimers.push(id);
  });

  handle.endTimer = setTimeout(() => {
    try { collector.stop("timeout"); } catch {}
  }, duration * 1000);

  // ✅ mark active vote in state
  state.vote = handle;
  state.isVotingInProgress = true;
}

module.exports = { startVote };
