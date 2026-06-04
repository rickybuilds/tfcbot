// TestHandle.js
"use strict";

require("dotenv").config(); // loads DISCORD_TOKEN from .env

const dgram = require("dgram");
const { Client, GatewayIntentBits } = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN; // from .env
const DEBUG_CHANNEL = "1416833040432238684";     // your test channel
const PORT = 27500;                              // must match logaddress_add port

// Create Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once("ready", () => {
  console.log(`[TEST] Discord logged in as ${client.user.tag}`);

  // Start UDP listener
  const sock = dgram.createSocket("udp4");

  sock.on("message", async (msg, rinfo) => {
    const raw = msg.toString().trim();
    console.log(`[TEST] Packet from ${rinfo.address}: ${raw}`);

    try {
      const ch = await client.channels.fetch(DEBUG_CHANNEL);
      if (ch) {
        await ch.send(
          `📡 **HLDS Packet** from \`${rinfo.address}\`\n\`\`\`\n${raw}\n\`\`\``
        );
      }
    } catch (e) {
      console.error("[TEST] Failed to send to channel:", e);
    }
  });

  sock.on("listening", () => {
    const addr = sock.address();
    console.log(`[TEST] Listening on udp://${addr.address}:${addr.port}`);
  });

  sock.bind(PORT, "0.0.0.0");
});

client.login(DISCORD_TOKEN);
