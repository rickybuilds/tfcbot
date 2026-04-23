// commands/spintest.js
"use strict";
const { EmbedBuilder } = require("discord.js");

const maps = ["dull", "razor", "lovin", "bofa", "deez", "nutz"];

module.exports = {
  name: "spintest",
  description: "Map spinner with flashing colors (rate-limit safe)",
  async execute(message) {
    // 🔒 Only allow Ricky to run this command
    const OWNER_ID = ["255834576742645761","737481545216163891","468578577537826831"];
    if (!OWNER_ID.includes(message.author.id)) {
      try {
        if (message.deletable) await message.delete().catch(() => {});
      } catch {}
      return; // silently ignore
    }

    const spinMsg = await message.channel.send("🎰 Initializing safe spinner...");
    console.log("[spintest] 🎰 Starting rate-limit-safe spinner...");

    const winner = maps[Math.floor(Math.random() * maps.length)];
    let reels = ["?", "?", "?"];

    const totalFrames = 18;
    const delayStart = 200;
    const delayEnd = 900;
    const easeOut = (t) => delayStart + (delayEnd - delayStart) * (t ** 2);

    const box = (a, b, c, mapList = "") =>
      "```\n" +
      "╔═════════════════════╗\n" +
      "║ ┌─────┬─────┬─────┐ ║\n" +
      `║ │  ${a}  │  ${b}  │  ${c}  │ ║\n` +
      "║ └─────┴─────┴─────┘ ║\n" +
      "╚═════════════════════╝\n" +
      "```\n" +
      mapList;

    const mapListText = maps.map((m, i) => `${i + 1}. ${m}`).join(" | ");

    let colorToggle = false;
    let lastEdit = 0;

    for (let i = 0; i < totalFrames; i++) {
      const now = Date.now();
      const progress = i / totalFrames;
      const delay = easeOut(progress) + Math.random() * 100;

      // randomize reels
      reels = reels.map((r, idx) => {
        const shouldSpin = i < totalFrames - (idx * 3 + 3);
        return shouldSpin ? String(Math.ceil(Math.random() * maps.length)) : reels[idx];
      });

      if (now - lastEdit > 500) {
        colorToggle = !colorToggle;
        lastEdit = now;

        const embed = new EmbedBuilder()
          .setColor(colorToggle ? 0xed4245 : 0x5865f2)
          .setDescription(box(reels[0], reels[1], reels[2], mapListText))
          .setFooter({ text: "Spinning..." });

        await spinMsg.edit({ embeds: [embed] });
      }

      await new Promise((r) => setTimeout(r, delay));
    }

	// final winner
	const winIndex = maps.indexOf(winner) + 1;
	reels = [winIndex, winIndex, winIndex];

	const finalEmbed = new EmbedBuilder()
	  .setColor(0x57f287)
	  .setDescription(
		box(reels[0], reels[1], reels[2], mapListText + "\n\n") + // ⬅️ added extra line break
		`🧠 **Winner:** ${winner.toUpperCase()}`
	  );

    await spinMsg.edit({ embeds: [finalEmbed] });
    console.log(`[spintest] ✅ Final map: ${winner}`);
  },
};
