"use strict";

module.exports = {
  name: "emilio",
  aliases: ["lag"],

  description: "The emilio clip",

  async execute(message) {
    await message.channel.send(
      "https://www.youtube.com/watch?v=VNOO85RzwNQ"
    );
  }
};