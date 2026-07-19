// commands/jaillist.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../lib/guards");

async function register(reg, deps) {
  const { jailStore } = deps;

  reg.set("jaillist", async (message) => {
    if (!isAdmin(message)) return;

    const allJailed = jailStore.all();

    const ids = Object.keys(allJailed || {});
    if (ids.length === 0) {
      await message.channel.send("✅ No one is currently in jail.");
      return;
    }

    const lines = [];
    for (const id of ids) {
      const data = allJailed[id];
      if (!data) continue;

      const member = await message.guild.members.fetch(id).catch(() => null);
      const name = member ? member.user.tag : `Unknown (${id})`;
      const reason = data.reason || "No reason provided";
      const admin = data.admin ? `<@${data.admin}>` : "Unknown";
      const expires =
        data.expires >= 32503680000000
          ? "Never"
          : new Date(data.expires).toLocaleString();

      lines.push(
        `**${name}** — ⏳ *Expires:* ${expires}\n🧑‍⚖️ *Admin:* ${admin}\n💬 *Reason:* ${reason}`
      );
    }

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("⛓️ Current Jail List")
      .setDescription(lines.join("\n\n"))
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  });
}

module.exports = { register };
