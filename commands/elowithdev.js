// commands/elowithdev.js
"use strict";

const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const config = require("../config");

// --- Helpers ---
const toArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

function isoFrom(ts) {
  const d = new Date((ts || 0) * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function mapNameOf(m) {
  if (!m) return "Unknown";
  if (m.map && typeof m.map === "object" && m.map.name) return m.map.name;
  return m.mapName ?? m.map ?? m?.vote?.map ?? m?.voting?.map ?? "Unknown";
}

function getTeams(m) {
  return {
    blue: toArr(m.blueTeam).length ? toArr(m.blueTeam) : toArr(m.blue),
    red: toArr(m.redTeam).length ? toArr(m.redTeam) : toArr(m.red),
  };
}

function userTeam(m, uid) {
  const { blue, red } = getTeams(m);
  const normalize = (p) => String(p?.id ?? p?.user_id ?? p?.userId ?? p ?? "");
  const target = String(uid);
  const blueIds = blue.map(normalize);
  const redIds = red.map(normalize);
  if (blueIds.includes(target)) return "Blue";
  if (redIds.includes(target)) return "Red";
  return null;
}

function resultForUser(m, team) {
  const winner = String(m?.winner || m?.winningTeam || m?.result || "").toLowerCase();
  const teamNorm = String(team || "").toLowerCase();
  if (winner === "tie" || winner === "draw") return "Tie";
  if (!winner || !teamNorm) return "Unknown";
  return winner === teamNorm ? "Win" : "Loss";
}

function isAdmin(member) {
  const adminRole = config.roles.admin;
  return (
    member?.roles?.cache?.has(adminRole) ||
    member?.permissions?.has("Administrator")
  );
}

// --- Command Definition ---
module.exports = {
  name: "elowithdev",
  usage: "!elowithdev <user1_id|@user> <user2_id|@user>",
  cooldownMs: 0,

  async run(message, deps) {
    const { elo, matchesStore, state } = deps || {};

    // ✅ Admin-only access
    if (!isAdmin(message.member)) {
      return message.reply("🚫 You don't have permission to use this command.");
    }

    // Parse args
    const args = message.content.trim().split(/\s+/).slice(1);
    if (args.length < 2) {
      return message.reply("Usage: `!elowithdev <user1_id|@user> <user2_id|@user>`");
    }

    const extractId = (arg) => arg.replace(/[<@!>]/g, "");
    const uid = extractId(args[0]);
    const partnerId = extractId(args[1]);

    // --- Load all matches ---
    let allMatches = [];
    try {
      if (matchesStore?.getAll) allMatches = matchesStore.getAll();
      else if (matchesStore?.getRecent) allMatches = matchesStore.getRecent(1000);
      else if (state?.matches) allMatches = state.matches;
    } catch {}

    const byId = new Map();
    for (const m of toArr(allMatches)) {
      const id = String(m?.id || m?.matchId || "");
      if (id) byId.set(id, m);
    }

    // --- Elo rows for both users ---
    let eloRows = [];
    try {
      eloRows = elo.db
        .prepare(
          `SELECT match_id, before, after, delta, ts, player_id
           FROM rating_changes
           WHERE player_id IN (?, ?)
           ORDER BY ts DESC`
        )
        .all(uid, partnerId);
    } catch (e) {
      console.error("[elowithdev] elo query failed:", e);
    }

    // --- Group by match ---
    const byMatch = new Map();
    for (const r of eloRows) {
      const arr = byMatch.get(r.match_id) || [];
      arr.push(r);
      byMatch.set(r.match_id, arr);
    }

    const sharedRows = [];
    for (const [mid, arr] of byMatch.entries()) {
      const ids = new Set(arr.map((r) => String(r.player_id)));
      if (!ids.has(uid) || !ids.has(partnerId)) continue;

      const r = arr.find((x) => String(x.player_id) === uid);
      if (!r) continue;
      const m = byId.get(mid);
      if (!m) continue;

      const { blue, red } = getTeams(m);
      const idsBlue = new Set(blue.map((p) => String(p?.id ?? p?.userId ?? p)));
      const idsRed = new Set(red.map((p) => String(p?.id ?? p?.userId ?? p)));
      const sameTeam =
        (idsBlue.has(uid) && idsBlue.has(partnerId)) ||
        (idsRed.has(uid) && idsRed.has(partnerId));
      if (!sameTeam) continue;

      const team = userTeam(m, uid);
      const result = resultForUser(m, team);

      sharedRows.push({
        matchId: mid,
        date: isoFrom(r.ts),
        map: mapNameOf(m),
        result,
        before: r.before,
        delta: r.delta,
        after: r.after,
      });
    }

    if (!sharedRows.length) {
      return message.reply("⚠️ No shared matches found for these users.");
    }

    // --- CSV ---
    const csv = [
      "MatchId,Date,Map,Result,Before,Delta,After",
      ...sharedRows.map((r) =>
        [r.matchId, r.date, r.map, r.result, r.before, r.delta, r.after].join(",")
      ),
    ].join("\n");

    const attachment = new AttachmentBuilder(Buffer.from(csv, "utf8"), {
      name: `elowithdev_${uid}_${partnerId}.csv`,
    });

    // --- Embed summary ---
    const totalChange = sharedRows.reduce((s, r) => s + (r.delta || 0), 0);
    const emb = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle(`DEV Elo History (${uid} vs ${partnerId})`)
      .setDescription(
        `Found ${sharedRows.length} teammate match${
          sharedRows.length !== 1 ? "es" : ""
        }`
      )
      .addFields({
        name: "Total Elo Change (User1)",
        value: `${totalChange >= 0 ? "🟢 +" : "🔴 "}${totalChange}`,
        inline: false,
      })
      .setTimestamp();

    // --- DM the admin ---
    try {
      const dm = await message.author.createDM();
      await dm.send({
        content: `🧮 Here’s the shared match history for **${uid}** and **${partnerId}**:`,
        embeds: [emb],
        files: [attachment],
      });
    } catch (e) {
      console.error("[elowithdev] DM failed:", e);
      await message.reply("❌ Couldn’t DM you the results — check privacy settings.");
    }
  },
};
