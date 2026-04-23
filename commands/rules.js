// commands/rules.js
"use strict";

const { EmbedBuilder } = require("discord.js");

function register(registry, { config }) {
  registry.set("rules", async (message) => {
    try {
      // Pull from config, not hardcoded
      const RULES_CHANNEL_ID = String(config.channels.rules || "");
      if (!RULES_CHANNEL_ID) {
        console.error("[!rules] No rules channel configured in .env/config.js");
        return;
      }

      const channel = message.client.channels.cache.get(RULES_CHANNEL_ID);
      if (!channel) {
        console.error("[!rules] Channel not found:", RULES_CHANNEL_ID);
        return;
      }

      const emb = new EmbedBuilder()
        .setColor(0x57f287) // green
        .setTitle("📜 NoNamePickups Rules")
        .setDescription("Follow these 10 simple rules to keep games fun and fair.")
        .addFields(
          { name: "1. No Cheating", value: "No hacks, scripts, macros, exploits, or non-cosmetic explosion sprite modifications (e.g., clear, reduced, sped up, semi-transparent)." },
          { name: "2. No Chop Hopping", value: "No movement exploits like chop-hopping. 0 ducks when in view of another player, flag, or carrying flag; 1 duck OK if out of sight (e.g., yard concs)." },
          { name: "3. Mic Usage - Mandatory", value: "Use your mic for comms when possible (life happens)." },
          { name: "4. Be Sportsmanlike", value: "No griefing, racism, hate speech, or toxic behavior." },
          { name: "5. No Prematch Exploits", value: "No touching/throwing flag, deactivating securities, or leaving explodables affecting opponents at game start." },
          { name: "6. No Map-Specific Exploits", value: "On blutopia, no SGs in respawns; On cranked, don’t take flag into red base water exit; On fry_baked, don’t throw flag over flagroom wall; On copper/ostargh, going *in da drink* under the gates is **NOT permitted**."},
          { name: "7. No Technical Exploits", value: "No quickdet, pipedown/pipeup, or use of force_centerview/cl_pitchspeed." },
          { name: "8. Have Fun", value: "We’re here to play, improve, and enjoy the game together." },
          { name: "9. Play Your Best", value: "Try hard, don’t troll, and don’t AFK." },
          { name: "10. Respect Admins", value: "Admin calls are final. Appeals can be made outside the game." }
        )
        .setFooter({ text: "Breaking rules may result in bans." })
        .setTimestamp();

      await channel.send({ embeds: [emb] });

      if (message.guild) {
        try { await message.delete(); } catch {}
      }
    } catch (e) {
      console.error("[!rules] failed:", e);
    }
  });
}

module.exports = { register };
