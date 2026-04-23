// commands/searchelo.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin, guardChannel } = require("../lib/guards");

// optional import for rank calculation if elo instance doesn't expose a helper
let rankFromRatingFn = null;
try {
  rankFromRatingFn = require("../lib/elo").rankFromRating || null;
} catch { /* optional */ }

function register(reg, { config, elo }) {
  const ADMIN_CH = String(config.channels.eloAdmin || "");

  reg.set("searchelo", async (message, args = []) => {
    // Require admin role
    if (!isAdmin(message, config)) {
      return message.channel.send("⛔ Admins only.");
    }

    // Require in the configured admin channel
    const ok = await guardChannel(message, ADMIN_CH);
    if (!ok) return;

    const query = args.join(" ").trim();
    if (!query) {
      return message.channel.send("Usage: `!searchelo <display name>`");
    }

    // ---------- find candidates by display_name (fuzzy, best exact match first)
    let candidates = [];
    try {
      if (typeof elo.findByDisplayName === "function") {
        const res = await elo.findByDisplayName(query);
        if (Array.isArray(res)) candidates = res;
        else if (res) candidates = [res];
      } else if (elo.db) {
        const like = `%${query}%`;
        const stmt = elo.db.prepare(`
          SELECT player_id, display_name, rating
          FROM ratings
          WHERE LOWER(display_name) LIKE LOWER(?)
          ORDER BY (LOWER(display_name) = LOWER(?)) DESC, rating DESC
          LIMIT 5
        `);
        candidates = stmt.all(like, query);
      }
    } catch (e) {
      console.error("[!searchelo] search failed:", e);
      return message.channel.send("Search failed.");
    }

    if (!candidates?.length) {
      return message.channel.send("No players found by that name.");
    }

    const best =
      candidates.find(
        (r) =>
          String(r.display_name || r.name || "").toLowerCase() === query.toLowerCase()
      ) || candidates[0];

    const playerId = String(best.player_id || best.id);
    const display = best.display_name || best.name || playerId;
    let rating = typeof best.rating === "number" ? best.rating : null;

    if (rating == null && typeof elo.getRating === "function") {
      try {
        rating = elo.getRating(playerId, display);
      } catch {}
    }
    if (rating == null) rating = 0;

    let rank = "";
    if (typeof elo.rankFromRating === "function") rank = elo.rankFromRating(rating);
    else if (typeof rankFromRatingFn === "function") rank = rankFromRatingFn(rating);
    else rank = String(rating);

    let last = null;
    try {
      if (typeof elo.getLastChangeForPlayer === "function") {
        last = elo.getLastChangeForPlayer(playerId);
      } else if (elo.db) {
        const stmt = elo.db.prepare(`
          SELECT match_id, ts, before, after, delta
          FROM rating_changes
          WHERE player_id=?
          ORDER BY ts DESC, id DESC
          LIMIT 1
        `);
        last = stmt.get(playerId);
      }
    } catch (e) {
      console.error("[!searchelo] last-change lookup failed:", e);
    }

    const lastTxt = last
      ? `**${last.match_id || "N/A"}** — <t:${Math.floor(last.ts || 0)}:f> (Δ ${last.delta >= 0 ? "+" : ""}${last.delta})`
      : "_no games logged yet_";

    const emb = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Elo Search — "${query}"`)
      .addFields(
        { name: "Player", value: `${display} \`${playerId}\`` },
        { name: "Elo", value: String(rating), inline: true },
        { name: "Rank", value: String(rank), inline: true },
        { name: "Last game", value: lastTxt }
      )
      .setTimestamp();

    if (candidates.length > 1) {
      emb.setFooter({ text: `Best match shown (found ${candidates.length} candidates).` });
    }

    await message.channel.send({ embeds: [emb] });
  });
}

module.exports = { register };
