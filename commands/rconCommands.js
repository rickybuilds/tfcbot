"use strict";

const { runRconCommand } = require("../services/rconClient");
const { EmbedBuilder } = require("discord.js");
const servers = require("../config/rcon");

const FORBIDDEN = ["quit", "exit", "restart"];
const publicServerEntries = () =>
  Object.entries(servers).filter(([, cfg]) => !cfg.trackingOnly);

module.exports = {
  name: "rcon",
  description: "RCON utilities: !rcon <server> <command>",

  async execute(message, args, deps) {
    const { config } = deps;
    let requestedServer = null;
    let command = null;

    if (args.length >= 2) {
      requestedServer = String(args[0]).toLowerCase();
      command = args.slice(1).join(" ");
    } else if (args.length === 1) {
      command = args[0];
    }

    if (!command) return message.reply("Usage: !rcon <server> <command>");
    const cmdLower = command.trim().toLowerCase();

    /* ---------------------------------------------------------------------- */
    /* 🕒 Special case: !timeleft                                             */
    /* ---------------------------------------------------------------------- */
    if (cmdLower === "timeleft") {
      const allowedChannels = [
        String(config.channels.pickup || ""),
        String(config.channels.maps || ""),
        String(config.channels.recap || "")
      ].filter(Boolean);

      if (!allowedChannels.includes(String(message.channel.id)))
        return message.channel.send("🚫 You can’t use !timeleft in this channel.");

      try {
        const { armed } = require("../services/autoRecap");
        const armedEntries = [...armed.entries()];
        const armedList = armedEntries.map(([key, a]) => ({
          key,
          serverName: a.serverName,
          serverIp: a.serverIp,
          matchId: a.matchId,
          map: a.map,
          half: a.half,
          done: a.done,
          halfScores: a.halfScores || [],
		  liveCaps: a.liveCaps || 0		  
        }));

        console.log("[!timeleft] Armed matches:", armedList);

        // 🧩 Case 1: specific server requested
        if (requestedServer) {
          return module.exports.runForServer(message, requestedServer, deps);
        }

        // 🧩 Case 2: no server requested, but armed matches exist → show armed ones
        if (armedList.length > 0) {
          const embeds = [];

          for (const armedMatch of armedList) {
            const matchedServer = publicServerEntries().find(([k, cfg]) => {
              const ipBase = String(cfg.host || "").split(":")[0].toLowerCase();
              return String(armedMatch.serverIp || "").split(":")[0].toLowerCase() === ipBase;
            });

            const [srvKey] = matchedServer || [];
            if (srvKey) {
              console.log(`[!timeleft] Using armed match server ${srvKey}`);
              const embed = await module.exports.runForServer(
                message,
                srvKey,
                deps,
                armedMatch,
                true // internal flag for embed-only
              );
              if (embed) embeds.push(embed);
            }
          }

          if (embeds.length > 0)
            return message.channel.send({ embeds });
        }

        // 🧩 Case 3: nothing armed → show all live servers
        console.log("[!timeleft] No armed matches found, showing all servers");
        const embeds = [];
        for (const [srvKey, srvCfg] of publicServerEntries()) {
          try {
            const rawStatus = await runRconCommand(srvKey, "status").catch(() => "");
            const rawTime = await runRconCommand(srvKey, "mp_timeleft").catch(() => "Unknown");

            let mapName = "Unknown";
            const mapLine = String(rawStatus || "")
              .split("\n")
              .find(l => l.toLowerCase().includes("map"));
            if (mapLine) {
              const parts = mapLine.split(":");
              if (parts.length > 1) mapName = parts[1].trim().split(/\s+/)[0];
            }

            const embed = new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle(`🟢 ${srvCfg.name}`)
              .addFields([
                { name: "🗺️ Map", value: `\`${mapName}\``, inline: true },
                { name: "⏱️ Timeleft", value: `\`${String(rawTime || "Unknown")}\``, inline: true }
              ])
              .setFooter({ text: "No active matches currently armed" })
              .setTimestamp();

            embeds.push(embed);
          } catch (err) {
            console.error(`[!timeleft fallback] Failed for ${srvKey}:`, err);
          }
        }

        return embeds.length
          ? message.channel.send({ embeds })
          : message.channel.send("❌ Could not fetch live map/timeleft info.");
      } catch (err) {
        console.error("[RCON ERROR]", err);
        return message.channel.send("❌ Failed to fetch timeleft info.");
      }
    }

    /* ---------------------------------------------------------------------- */
    /* ⚙️  Normal RCON commands                                              */
    /* ---------------------------------------------------------------------- */
    const rconRole = String(config.roles.admin || "");
    if (!rconRole || !message.member.roles.cache.has(rconRole))
      return message.channel.send("🚫 No permission to use !rcon commands.");

    if (FORBIDDEN.includes(cmdLower))
      return message.channel.send("⚠️ Command ignored: that could restart or kill the TFC server.");

    try {
      const serverKey = requestedServer && servers[requestedServer] ? requestedServer : null;
      const targetServer = serverKey || publicServerEntries()[0]?.[0]; // fallback to first public server if none provided

      if (!targetServer) {
        return message.channel.send("❌ No public servers are configured.");
      }

      const result = await runRconCommand(targetServer, command);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`RCON Response — ${servers[targetServer].name}`)
        .addFields(
          { name: "Command", value: `\`${command}\`` },
          {
            name: "Result",
            value:
              typeof result === "string" && result.length
                ? result.slice(0, 1900)
                : "No response"
          }
        )
        .setTimestamp();

      return message.channel.send({ embeds: [embed] });
    } catch (err) {
      console.error("[RCON ERROR]", err);
      const errorEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle(`RCON Error — ${requestedServer || "unknown"}`)
        .setDescription("```" + (err?.message || "Unknown error") + "```")
        .setTimestamp();

      return message.channel.send({ embeds: [errorEmbed] });
    }
  },

  /* ---------------------------------------------------------------------- */
  /* 🧩 Helper: show timeleft for one server                                */
  /* ---------------------------------------------------------------------- */
  async runForServer(message, requestedServer, deps, armedMatch = null, returnEmbedOnly = false) {
    const { runRconCommand } = require("../services/rconClient");
    const { EmbedBuilder } = require("discord.js");
    const servers = require("../config/rcon");

    try {
      const serverCfg = servers[requestedServer];
      const rawMap = await runRconCommand(requestedServer, "status");
      const rawTime = await runRconCommand(requestedServer, "mp_timeleft");

      let mapName = armedMatch?.map || "Unknown";
      const mapLine = String(rawMap || "")
        .split("\n")
        .find(l => l.toLowerCase().includes("map"));
      if (mapLine) {
        const parts = mapLine.split(":");
        if (parts.length > 1) mapName = parts[1].trim().split(/\s+/)[0];
      }

		const embed = new EmbedBuilder()
		  .setColor(0x57f287)
		  .setTitle(`Pug Timeleft Info — ${serverCfg.name}`);

		const details = [];

		if (armedMatch) {
		  details.push(`🏷️ **Match ID:** ${armedMatch.matchId}`);

		  let roundLabel = "Round 1";
		  if (armedMatch.half === 1) roundLabel = "Round 2";
		  else if (armedMatch.half >= 2 || armedMatch.done) roundLabel = "Completed";

      /* removed on 5/27 and updated to below code 
	  const h1 = armedMatch.halfScores?.[0];
      `details.push(`**Current Round:** ${roundLabel}`);

      if (h1) {
        details.push(`**Round 1 Score:** 🔵 ${h1.blue} — 🔴 ${h1.red}`);
      } else {
        details.push("**Round 1 Score:** Round 1 not completed yet");
      }
	  
	  Updated below here until next comment*/
	  
		const h1 = armedMatch.halfScores?.[0];
		const liveCaps = armedMatch.liveCaps || 0;
		const liveScore = liveCaps * 10;

		details.push(`**Current Round:** ${roundLabel}`);

		if (h1) {
		  details.push(`**Round 1 Score:** 🔵 ${h1.blue} — 🔴 ${h1.red}`);
		}

		details.push(
		  `**Current Score:** ${liveScore}`
		);
		/* until here */

		  details.push(`🗺️ **Map:** ${mapName}`);
		  details.push(`⏱️ **Timeleft:** ${String(rawTime || "Unknown")}`);
		} else {
		  details.push(`🗺️ **Map:** ${mapName}`);
		  details.push(`⏱️ **Timeleft:** ${String(rawTime || "Unknown")}`);
		}

		embed.addFields([{ name: "Match Details", value: details.join("\n") }]);
		embed.setTimestamp();

		if (returnEmbedOnly) return embed;
		return message.channel.send({ embeds: [embed] });

    } catch (err) {
      console.error("[runForServer error]", err);
      if (!returnEmbedOnly)
        return message.channel.send("❌ Failed to fetch timeleft info for that server.");
    }
  }
};
