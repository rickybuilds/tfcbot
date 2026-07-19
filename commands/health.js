// commands/health.js
"use strict";

const { gatherHealth, fmtUptime } = require("../services/health");
const { EmbedBuilder } = require("discord.js");

const OVERALL_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 12000);

function withTimeout(promise, ms, label = "health") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[${label}] Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  name: "health",
  aliases: ["hcheck", "hc"],
  description: "Show bot/server/HLDS health at a glance.",
  usage: "!health",

  async run(message) {
    const targetId = process.env.HEALTH_CHANNEL_ID || "1411889903930704014";
    let health;
    try {
      health = await withTimeout(gatherHealth(message.client, process.env), OVERALL_TIMEOUT_MS);
    } catch (e) {
      return message.channel.send(`❌ Health check failed: ${e.message || e}`);
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 Health — TFCBot")
      .setColor(0x57f287)
      .setTimestamp()
      .addFields(
  {
    name: "Bot",
    value: `Uptime: \`${fmtUptime(health.bot.uptime)}\`\nNode: \`${health.bot.node}\`\nMem: \`${health.bot.memMb} MB\`\nServer(s): \`${health.bot.guilds}\`\nMembers cached: \`${health.bot.users}\``,
    inline: true,
  },
	{
	  name: "Discord",
	  value: (() => {
		let pingDisplay = "?";
		const ping = Number(health.discord?.ping);
		if (Number.isFinite(ping) && ping >= 0) {
		  pingDisplay = `${ping}ms`;
		}
		const statusCodes = { 0: "Ready", 1: "Connecting", 2: "Reconnecting", 3: "Idle", 4: "Nearly", 5: "Disconnected" };
		const status = statusCodes[health.discord?.status] ?? "Unknown";
		return `Ping: \`${pingDisplay}\`\nWS Status: \`${status}\``;
	  })(),
	  inline: false,
	},
	{
	  name: "HLDS",
	  value: `Port: \`${health.hlds.port}\`\nAllowed: [${(health.hlds.allowed || []).join(", ")}]\nLast packet: \`${typeof health.hlds.lastPacketAge === "number"
		? health.hlds.lastPacketAge.toFixed(1) + "s"
		: "n/a"}\``,
	  inline: false,
	},
  {
    name: "SFTP",
    value: health.sftp
      ? (health.sftp.ok
        ? `✅ \`${health.sftp.count} files\` (${health.sftp.ms}ms)`
        : `❌ ${health.sftp.error}`)
      : "n/a",
    inline: false,
  },
  {
    name: "Hampalyzer",
    value: health.hampalyzer
      ? (health.hampalyzer.ok
        ? `✅ \`${health.hampalyzer.status}\` (${health.hampalyzer.ms}ms)`
        : `❌ ${health.hampalyzer.error}`)
      : "n/a",
    inline: false,   // <- force full row
  },
  {
    name: "Databases",
    value: Object.entries(health.db || {})
      .map(([k,v]) => `\`${k}: ${v}\``)
      .join("\n") || "n/a",
    inline: false,
  },
        {
          name: "Disk",
          value: typeof health.disk === "string" ? `\`${health.disk}\`` : JSON.stringify(health.disk),
          inline: false,
        },
		{
		  name: "CPU",
		  value: (() => {
			const loads = Array.isArray(health.cpu?.load)
			  ? health.cpu.load.map(v => Number(v)).map(v => (Number.isFinite(v) ? v : 0))
			  : [];
			const loadStr = loads.length
			  ? loads.map(v => v.toFixed(2)).join(", ")
			  : "n/a";
			const coresStr = Number.isFinite(Number(health.cpu?.cores))
			  ? String(health.cpu.cores)
			  : "n/a";
			return `Load: \`${loadStr}\`\nCores: \`${coresStr}\``;
		  })(),
		  inline: false,
		},
      );

    try {
      const ch = await message.client.channels.fetch(String(targetId));
      if (ch && ch.isTextBased()) {
        await ch.send({ embeds: [embed] });
        if (message.channel.id !== String(targetId)) {
          await message.channel.send(`✅ Posted health status in <#${targetId}>.`);
        }
        return;
      }
    } catch (e) {
      console.error(`[!health] could not post to target channel:`, e);
    }

    // fallback: post in the current channel
    await message.channel.send({ embeds: [embed] });
  },
};
