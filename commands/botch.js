"use strict";

const BOTCH_URL = "https://nonamepickup.servehalflife.com/coolest-dude.html";

function register(registry) {
  registry.set("botch", async (message) => {
    await message.reply(`[Coolest dude](${BOTCH_URL})`);
  });
}

module.exports = { BOTCH_URL, register };
