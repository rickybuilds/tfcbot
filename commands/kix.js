"use strict";

module.exports = {
  name: "kix",
  description: "The kix clip",

  async execute(message) {
    await message.channel.send(
      "https://www.twitch.tv/r0flz/clip/UglyGrotesqueCattlePraiseIt"
    );
  }
};