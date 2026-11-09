"use strict";

function register(registry, service) {
  registry.set("refund", async (message, args) => {
    if (!message.guild || !service.config.predictionsOwnerId || String(message.author.id) !== service.config.predictionsOwnerId) return;
    const match = /^(?:<@!?(\d{15,22})>|(\d{15,22}))$/.exec(args[0] || "");
    const amount = /^[1-9]\d*$/.test(args[1] || "") ? Number(args[1]) : NaN;
    const reason = args.slice(2).join(" ").trim();
    const send = content => message.channel.send({content, allowedMentions:{parse:[]}});
    if (!match || !Number.isSafeInteger(amount) || !reason) return send("Usage: !refund <Discord ID|@player> <positive whole points> <reason>");
    const target = match[1] || match[2];
    try {
      service.store.adjust(target, amount, {operationKey:`refund:${message.id}`, actorId:String(message.author.id), reason, now:service.clock()});
    } catch {
      return send("Unable to refund points. Check the amount and try again.");
    }
    await send(`Refunded **${amount.toLocaleString("en-US")} points** to <@${target}>.`);
  });
}
module.exports = {register};
