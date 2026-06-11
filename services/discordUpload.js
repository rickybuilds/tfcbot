"use strict";

const fs = require("fs");
const { AttachmentBuilder, EmbedBuilder } = require("discord.js");
const rconCfg = require("../config/rcon"); // ✅ add this line
const os = require("os");


const { spawn } = require("child_process");

function importHampalyzerStats(matchId, hampalyzerUrl) {
  if (!matchId || !hampalyzerUrl) return;
  if (!/^https?:\/\/app\.hampalyzer\.com\/parsedlogs\//i.test(hampalyzerUrl)) return;

  const child = spawn("node", [
    "/root/tfcbot/hampalyzerImport.js",
    String(matchId),
    String(hampalyzerUrl)
  ], {
    cwd: "/root/tfcbot",
    stdio: "ignore",
    detached: true
  });

  child.unref();
}

/**
 * sendRecapWithDemos(client, channelId, options)
 */
async function sendRecapWithDemos(client, channelId, options = {}) {
  const ch = await client.channels.fetch(channelId);
  if (!ch) throw new Error("channel not found");

  const { matchInfo = {}, tfcstats, hampalyzer, mentionRoles } = options;
  let { map, scoreBlue, scoreRed, winner, matchId, id, server } = matchInfo;

  // 🧠 try to resolve server if missing
  if (!server || server === "unknown") {
    try {
      // 1️⃣ match the HLTV / RCON IP from rconCfg host entries
      const entries = Object.entries(rconCfg);
      const selfIps = Object.values(os.networkInterfaces())
        .flat()
        .map(n => n.address)
        .filter(Boolean);

      const found = entries.find(([key, srv]) =>
        selfIps.some(ip => String(srv.host).includes(ip))
      );
      if (found) server = found[0];
      else server = entries[0]?.[0] || "east"; // fallback
    } catch {
      server = "east";
    }
  }

  const displayId = matchId || id || "N/A";
console.log(`[sendRecapWithDemos] ✅ Server detected: ${server}`);

  // 🧱 Build a consistent, informative title
  const embedTitleParts = ["Match Reported"];
  if (map) embedTitleParts.push(`— ${map}`);
  embedTitleParts.push(`— ${server ? server.toUpperCase() : "UNKNOWN SERVER"}`);
  if (displayId) embedTitleParts.push(`— ID: ${displayId}`);
  const embedTitle = embedTitleParts.join(" ");

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(embedTitle)
    .addFields(
      {
        name: "Blue Team 🔵",
        value: `Score: **${scoreBlue ?? "?"}**`,
        inline: true,
      },
      {
        name: "Red Team 🔴",
        value: `Score: **${scoreRed ?? "?"}**`,
        inline: true,
      },
      {
        name: "\u200B",
        value: [
          `Winner: **${winner?.toUpperCase() || "Unknown"}**`,
          `${tfcstats?.url ? `[View TFCStats](${tfcstats.url})` : "View TFCStats"} • ${
            hampalyzer?.url ? `[View Hampalyzer](${hampalyzer.url})` : "View Hampalyzer"
          }`,
        ].join("\n"),
        inline: false,
      }
    )
    .setTimestamp();

  await ch.send({
    content: mentionRoles || null,
    embeds: [embed],
  });

if (hampalyzer?.url && displayId && displayId !== "N/A") {
  console.log(`[hampalyzerImport] Queuing stats import for ${displayId}`);
  importHampalyzerStats(displayId, hampalyzer.url);
}

  // 📎 Optional attachment
  if (options.zipPath && fs.existsSync(options.zipPath)) {
    const attachment = new AttachmentBuilder(options.zipPath);
    await ch.send({ files: [attachment] });
  } else {
    console.log("[sendRecapWithDemos] No zipPath found or file missing.");
  }
}

module.exports = { sendRecapWithDemos };
