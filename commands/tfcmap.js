// commands/tfcmap.js
"use strict";

const fetch = require("node-fetch");

async function checkMrClan(mapName) {
  try {
    const url = "http://mrclan.com/tfcmaps/";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    const html = await res.text();

    const regex = new RegExp(`<a href="/tfcmaps/${mapName}\\.zip`, "i");
    return regex.test(html);
  } catch (err) {
    console.error("[tfcmap] checkMrClan failed:", err);
    return false;
  }
}

function register(reg) {
  reg.set("tfcmap", async (message, args) => {
    const mapName = (args[0] || "").toLowerCase();
    if (!mapName) {
      return message.reply("Usage: `!tfcmap <mapname>`");
    }

    try {
      const found = await checkMrClan(mapName);
      if (found) {
        return message.reply(`✅ Found map: http://mrclan.com/tfcmaps/${mapName}.zip`);
      } else {
        return message.reply(`🔎 Not found on mrclan, try: https://tfcmaps.net/?filterMap=${mapName}`);
      }
    } catch (err) {
      console.error("[tfcmap] command failed:", err);
      return message.reply("⚠️ Error checking map availability.");
    }
  });

  // add an alias !map
  reg.set("map", (msg, args) => reg.get("tfcmap")(msg, args));
}

module.exports = { register };
