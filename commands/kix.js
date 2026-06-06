"use strict";

module.exports = {
  name: "kix",
  aliases: ["rufio"],
  description: "The kix clip",

  async execute(message) {
    await message.channel.send(
      "https://www.twitch.tv/r0flz/clip/UglyGrotesqueCattlePraiseIt"
    );
  }
};
