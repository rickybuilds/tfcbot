// commands/permapelo.js
"use strict";

/**
 * Per-map Elo & W/L/T for a user — DMs the result and deletes the trigger in guilds.
 * Only admins (config.roles.admin) may query OTHER users via mention.
 * Non-admins can only query their own stats.
 *
 * Usage:
 *   !permapelo                 -> you, last 30 days
 *   !permapelo 90              -> you, last 90 days
 *   !permapelo @user           -> (ADMIN ONLY) that user, last 30 days
 *   !permapelo @user 60        -> (ADMIN ONLY) that user, last 60 days
 */

const { EmbedBuilder } = require("discord.js");

// ---------- helpers ----------
const safeArr = (x) => (Array.isArray(x) ? x : []);

const idOf   = (p) => String(p?.id ?? p?.userId ?? p?.user_id ?? p ?? "");
const nameOf = (p) =>
  String(p?.name ?? p?.display_name ?? p?.username ?? p?.tag ?? p?.id ?? "Unknown");

function mapNameOf(m) {
  if (m?.map && typeof m.map === "object" && m.map.name) return String(m.map.name);
  return String(m?.mapName ?? m?.map ?? m?.vote?.map ?? m?.voting?.map ?? "Unknown");
}

function getTeams(m) {
  const blueSrc = Array.isArray(m?.blueTeam) && m.blueTeam.length ? m.blueTeam : safeArr(m?.blue);
  const redSrc  = Array.isArray(m?.redTeam) && m.redTeam.length ? m.redTeam : safeArr(m?.red);
  const blue = blueSrc.map((p) => ({ id: idOf(p), name: nameOf(p) }));
  const red  = redSrc .map((p) => ({ id: idOf(p), name: nameOf(p) }));
  return { blue, red };
}

function participantSide(m, uid) {
  const { blue, red } = getTeams(m);
  const onBlue = blue.some((p) => p.id === uid);
  const onRed  = red .some((p) => p.id === uid);
  return { onBlue, onRed };
}

function winnerLabelFromFields(m) {
  const wRaw = (m?.winner ?? m?.winningTeam ?? m?.result ?? "");
  if (wRaw && typeof wRaw === "string") {
    const w = wRaw.trim().toLowerCase();
    if (w.includes("blue")) return "Blue";
    if (w.includes("red"))  return "Red";
    if (w === "tie" || w === "draw") return "Tie";
  }
  const sb = Number(m?.scoreBlue ?? m?.blueScore);
  const sr = Number(m?.scoreRed  ?? m?.redScore);
  if (!Number.isNaN(sb) && !Number.isNaN(sr)) return sb > sr ? "Blue" : sr > sb ? "Red" : "Tie";
  return "";
}

function isAdmin(message, config) {
  try {
    if (!message.guild) return false;
    const mem = message.member || message.guild.members.cache.get(message.author.id);
    const roleId = String(config.roles.admin || "");
    return roleId && mem?.roles?.cache?.has(roleId);
  } catch {
    return false;
  }
}

function parseTargetAndDays(message, args, allowMention) {
  let targetUser = message.author;
  let days = 30;

  const toNum = (s) => {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };

  const mention = allowMention ? message.mentions?.users?.first?.() : null;
  if (mention) targetUser = mention;

  if (!mention && args[0]) {
    const n = toNum(args[0]);
    if (n) days = n;
  } else if (mention) {
    const other = args.find(
      (a) => a !== `<@${mention.id}>` && a !== `<@!${mention.id}>`
    );
    const n = toNum(other);
    if (n) days = n;
  }

  return { targetUser, days };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------- main command ----------
module.exports = {
  name: "permapelo",
  aliases: ["pmelo"],
  usage: "!permapelo [@user] [days]",
  cooldownMs: 10_000,

  async run(message, deps) {
    const { state, matchesStore, elo, config } = deps || {};
	// ------------------ audit log ------------------
	try {
	  const channelId = config?.channels?.audit;
	  if (message.client && channelId) {
		const auditCh = await message.client.channels.fetch(channelId).catch(() => null);
		if (auditCh && auditCh.isTextBased()) {
		  await auditCh.send(
			`🗺️ PERMAPELO: <@${message.author.id}> ran \`!permapelo ${message.content.split(/\s+/).slice(1).join(" ")}\``
		  );
		}
	  }
	} catch (err) {
	  console.warn("[permapelo audit] failed:", err);
	}
	// ------------------------------------------------

    const args = (message.content || "").split(/\s+/).slice(1);

    const attemptedOther =
      Boolean(message.mentions?.users?.first?.()) &&
      String(message.mentions.users.first().id) !== String(message.author?.id || "");

    const canQueryOthers = isAdmin(message, config) && Boolean(message.guild);
    const { targetUser, days } = parseTargetAndDays(message, args, canQueryOthers);
    const uid = String(targetUser?.id || message.author?.id || "");
    if (!uid) return;

    const now = Date.now();
    const cutoffMs = now - clamp(days, 1, 3650) * 24 * 60 * 60 * 1000;

    // 1) Load matches (preferred for metadata + W/L/T)
    let matches = [];
    try {
      if (matchesStore?.getAll) matches = matchesStore.getAll();
      else if (matchesStore?.getRecent) matches = matchesStore.getRecent(1000);
      else if (state?.matches) matches = state.matches;
    } catch {
      matches = safeArr(state?.matches);
    }

    // Index matches by id
    const byId = new Map();
    for (const m of safeArr(matches)) {
      const mid = String(m?.id ?? m?.matchId ?? "");
      if (mid) byId.set(mid, m);
    }

    // 2) Fetch Elo rows for THIS user (for deltas + timestamps)
    let eloRows = [];
    if (elo?.db) {
      try {
        eloRows = elo.db
          .prepare(
            `
            SELECT match_id, before, after, delta, ts
            FROM rating_changes
            WHERE player_id = ?
            ORDER BY ts ASC, rowid ASC
          `
          )
          .all(uid);
      } catch (e) {
        console.error("[permapelo] elo query failed:", e);
      }
    }

    // Aggregation by map
    // entry: { map, games, wins, losses, ties, deltas: number[], last_ts, _countedIds? }
    const perMap = new Map();

    // ---- Pass 1: use Elo rows linked to matches (adds Δ and W/L/T when match exists) ----
    for (const r of eloRows) {
      const mid = String(r?.match_id ?? "");
      if (!mid) continue;
      const m = byId.get(mid);
      if (!m) continue; // Can't attribute to a map without the match object

      // time filter: prefer elo ts, fallback to match createdAt
      const tsMs = Number(r?.ts ?? 0) * 1000 || Number(m?.createdAt ?? 0) || 0;
      if (tsMs && tsMs < cutoffMs) continue;

      const mapKey = mapNameOf(m);
      const { onBlue, onRed } = participantSide(m, uid);
      if (!onBlue && !onRed) continue; // user not in this match (unlikely, but safe)

      // winner label from fields/scores
      let lab = winnerLabelFromFields(m);
      if (!lab) {
        // Last resort: infer from YOUR delta sign
        const d = Number(r?.delta ?? 0);
        if (Number.isFinite(d)) {
          lab = d > 0 ? (onBlue ? "Blue" : onRed ? "Red" : "Win")
                      : d < 0 ? (onBlue ? "Red"  : onRed ? "Blue" : "Loss")
                              : "Tie";
        }
      }

      const entry =
        perMap.get(mapKey) || {
          map: mapKey,
          games: 0,
          wins: 0,
          losses: 0,
          ties: 0,
          deltas: [],
          last_ts: 0,
          _countedIds: new Set(),
        };

      if (!entry._countedIds.has(mid)) {
        entry.games += 1;
        entry._countedIds.add(mid);

        if (lab === "Tie") entry.ties += 1;
        else if (lab === "Blue") {
          if (onBlue) entry.wins += 1;
          if (onRed) entry.losses += 1;
        } else if (lab === "Red") {
          if (onRed) entry.wins += 1;
          if (onBlue) entry.losses += 1;
        }
      }

      const dNum = Number(r?.delta ?? 0);
      if (Number.isFinite(dNum)) entry.deltas.push(dNum);

      if (tsMs > entry.last_ts) entry.last_ts = tsMs;

      perMap.set(mapKey, entry);
    }

    // ---- Pass 2: sweep recent matches to count games/WLT missing from Pass 1 ----
    for (const m of safeArr(matches)) {
      const created = Number(m?.createdAt ?? 0);
      if (created && created < cutoffMs) continue;

      const { onBlue, onRed } = participantSide(m, uid);
      if (!onBlue && !onRed) continue;

      const mapKey = mapNameOf(m);
      const entry =
        perMap.get(mapKey) || {
          map: mapKey,
          games: 0,
          wins: 0,
          losses: 0,
          ties: 0,
          deltas: [],
          last_ts: 0,
          _countedIds: new Set(),
        };

      const mid = String(m?.id ?? m?.matchId ?? "");
      if (!entry._countedIds.has(mid)) {
        entry.games += 1;

        const lab = winnerLabelFromFields(m);
        if (lab === "Tie") entry.ties += 1;
        else if (lab === "Blue") {
          if (onBlue) entry.wins += 1;
          if (onRed) entry.losses += 1;
        } else if (lab === "Red") {
          if (onRed) entry.wins += 1;
          if (onBlue) entry.losses += 1;
        }

        if (mid) entry._countedIds.add(mid);
      }

      if (created > entry.last_ts) entry.last_ts = created;

      perMap.set(mapKey, entry);
    }

    // Finalize: compute avg Δ and render
    const rows = [];
    for (const [, v] of perMap) {
      const cnt = v.deltas.length || 0;
      const avg = cnt ? v.deltas.reduce((a, b) => a + b, 0) / cnt : 0;
      rows.push({
        map: v.map,
        games: v.games,
        wins: v.wins,
        losses: v.losses,
        ties: v.ties,
        avgDelta: avg,
        last_ts: v.last_ts || 0,
      });
    }

    // Sort: most games desc, then most recent
    rows.sort((a, b) => (b.games - a.games) || (b.last_ts - a.last_ts));

    const MAX_LINES = 15;
    const shown = rows.slice(0, MAX_LINES);
    const more = rows.length - shown.length;

    const bodyLines = shown.map((r) => {
      const avg = Number.isFinite(r.avgDelta) ? r.avgDelta : 0;
      const avgFmt =
        Math.abs(avg) < 0.005 ? "0.00" : (avg > 0 ? `+${avg.toFixed(2)}` : avg.toFixed(2));
      return `${r.map} — games: ${r.games}, W/L/T: ${r.wins}/${r.losses}/${r.ties}, avg Δ: ${avgFmt}`;
    });
    if (more > 0) bodyLines.push(`…and **${more}** more maps`);

    const targetName =
      message.guild?.members?.cache?.get?.(uid)?.displayName ??
      (targetUser?.username || targetUser?.tag) ??
      `User ${uid}`;

    const desc =
      bodyLines.length > 0
        ? bodyLines.join("\n")
        : `No matches found for the last **${days}** day(s).`;

    const embed = new EmbedBuilder()
      .setColor(0x2f3136)
      .setTitle(`Per-Map Stats — ${targetName}`)
      .setDescription(desc)
      .setFooter({
        text: `Source: Elo history (avg Δ) + match records • Last ${days}d • ${new Date().toLocaleString()}`,
      });

    // --- DM the user and delete trigger in guilds ---
    try {
      // DM the user
      const dm = await message.author.createDM();
      await dm.send({ embeds: [embed] });

      // If invoked in a guild, try to delete their command message
      if (message.guild && message.deletable) {
        try { await message.delete(); } catch {}
      }

      // If they tried to query someone else without permission, gently notify in-channel
      if (message.guild && attemptedOther && !canQueryOthers) {
        try {
          const warn = await message.channel.send({
            content: `<@${message.author.id}> only admins can query other users' per-map stats. I sent **your own** stats via DM.`,
            allowedMentions: { users: [message.author.id] },
          });
          setTimeout(() => warn.delete().catch(() => {}), 8000);
        } catch {}
      }

      // If they attempted mention in DM, remind them we can't verify admin roles there
      if (!message.guild && attemptedOther) {
        try {
          await dm.send(
            "Heads up: querying other users is **admin-only** and must be used in the server (roles can't be verified in DMs). I sent your own stats."
          );
        } catch {}
      }
    } catch (e) {
      console.error("[permapelo] DM/send failed:", e);

      // If we couldn't DM (e.g., DMs disabled), let them know in-channel briefly
      if (message.guild) {
        try {
          const warn = await message.reply({
            content: "I couldn't DM you your per-map stats. Please enable DMs from this server and try again.",
            allowedMentions: { repliedUser: false },
          });
          setTimeout(() => warn.delete().catch(() => {}), 8000);
        } catch {}
      }
    }
  },
};
