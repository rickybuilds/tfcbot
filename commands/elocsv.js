// commands/elocsv.js
"use strict";
const { AttachmentBuilder } = require("discord.js");
const config = require("../config");
const { csvEscape, isoFrom } = require("../lib/csv");

const ALLOWED_PUBLIC_CHANNEL = String(config.channels.pickup);

/* ------------------------- helpers ------------------------- */
function headerLine() {
  return [
    "GameIndex",
    "Date",
    "MatchId",
    "Map",
    "Server",
    "Teammates",
    "Opponents",
    "Winner",
    "Before",
    "Delta",
    "After",
  ].join(",");
}

function rowsToCsv(rows) {
  return headerLine() + (rows.length ? "\n" + rows.map((r) => r.map(csvEscape).join(",")).join("\n") : "");
}

/* -------------------- main command ---------------------- */
module.exports = {
  name: "elocsv",
  aliases: ["elocsv"],
  usage: "!elocsv",
  cooldownMs: 30_000,

  async run(message, deps) {
    const { elo } = deps || {};
	// ------------------ audit log ------------------
	try {
	  const config = deps?.config;
	  const channelId = config?.channels?.audit;
	  if (message.client && channelId) {
		const auditCh = await message.client.channels.fetch(channelId).catch(() => null);
		if (auditCh && auditCh.isTextBased()) {
		  await auditCh.send(
			`📄 ELOCSV: <@${message.author.id}> ran \`!elocsv\``
		  );
		}
	  }
	} catch (err) {
	  console.warn("[elocsv audit] failed:", err);
	}
	// ------------------------------------------------

    const uid = String(message.author?.id || "");
    if (!uid) return;

    const isDM = message.channel?.isDMBased?.() || message.channel?.type === 1;
    const allowed = isDM || String(message.channelId) === ALLOWED_PUBLIC_CHANNEL;
    if (!allowed) return;

    try {
      /* ---------------- Load player display names ---------------- */
      const playerNames = new Map();
      try {
        const players = elo.db.prepare("SELECT player_id, display_name FROM ratings").all();
        for (const p of players)
          playerNames.set(String(p.player_id), p.display_name || "Unknown");
      } catch (e) {
        console.warn("[elocsv] failed to load ratings names:", e);
      }

      /* ---------------- Fetch ELO history with matches ---------------- */
      const eloRows = elo.db
        .prepare(
          `SELECT 
              rc.match_id,
              rc.before,
              rc.after,
              rc.delta,
              rc.ts,
              m.map_name,
              m.server_name,
              m.blue_ids,
              m.red_ids,
              m.winner
           FROM rating_changes rc
           LEFT JOIN matches m ON rc.match_id = m.match_id
           WHERE rc.player_id = ?
           ORDER BY rc.ts ASC, rc.rowid ASC`
        )
        .all(uid);

      const rows = [];
      let idx = 0;

      for (const r of eloRows) {
        const mid = String(r.match_id || "");
        if (!mid || mid.startsWith("seed-") || mid.startsWith("admin")) continue;

        idx += 1;
        const map = r.map_name || "";
        const server = r.server_name || "";

        // parse teams
        let blue = [];
        let red = [];
        try {
          blue = JSON.parse(r.blue_ids || "[]");
          red = JSON.parse(r.red_ids || "[]");
        } catch {}

        const uidStr = String(uid);
        const onBlue = blue.includes(uidStr);
        const onRed = red.includes(uidStr);

        const teammates = onBlue
          ? blue.filter((id) => id !== uidStr)
          : onRed
          ? red.filter((id) => id !== uidStr)
          : [];
        const opponents = onBlue ? red : onRed ? blue : [];

        const mateNames = teammates.map((id) => playerNames.get(String(id)) || id).join(", ");
        const oppNames = opponents.map((id) => playerNames.get(String(id)) || id).join(", ");

        // winner logic
        let winner = (r.winner || "").trim();
        if (!winner) {
          if (r.delta > 0) winner = "Win";
          else if (r.delta < 0) winner = "Loss";
          else winner = "Tie";
        }

        rows.push([
          idx,
          isoFrom(r.ts),
          mid,
          map,
          server,
          mateNames,
          oppNames,
          winner,
          r.before ?? "",
          r.delta ?? "",
          r.after ?? "",
        ]);
      }

      /* ---------------- Create and send CSV ---------------- */
      const csvText = rowsToCsv(rows);
      const filename = `elo_history_${uid}.csv`;
      const attachment = new AttachmentBuilder(Buffer.from(csvText, "utf8"), { name: filename });

      const dm = await message.author.createDM();
      await dm.send({
        content: "Here’s your complete ELO match history CSV (includes maps, servers, teammates, and opponents).",
        files: [attachment],
      });

      if (!isDM && message.deletable) {
        try {
          await message.delete();
        } catch {}
      }
    } catch (e) {
      console.error("[!elocsv] error:", e);
      if (!message.channel?.isDMBased?.()) {
        try {
          const reply = await message.reply({
            content: `<@${uid}> I couldn't DM you the CSV. Please enable DMs from this server and try again.`,
            allowedMentions: { repliedUser: false },
          });
          setTimeout(() => reply.delete().catch(() => {}), 8000);
        } catch {}
      }
    }
  },
};
