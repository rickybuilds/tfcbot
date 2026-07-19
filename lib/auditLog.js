"use strict";

async function sendAuditLog({
  client,
  guild,
  channelId,
  payload,
  cacheFirst = false,
  requireTextBased = true,
  missingMessage,
  errorMessage,
  errorLevel = "warn",
}) {
  try {
    if (!channelId) {
      if (missingMessage) console.warn(missingMessage);
      return false;
    }

    let channel = cacheFirst ? guild?.channels?.cache?.get(channelId) : null;
    if (!channel && client?.channels?.fetch) {
      channel = await client.channels.fetch(channelId).catch(() => null);
    }

    if (!channel) {
      if (missingMessage) console.warn(missingMessage);
      return false;
    }
    if (requireTextBased && !channel.isTextBased()) return false;

    await channel.send(payload);
    return true;
  } catch (error) {
    if (errorMessage) {
      console[errorLevel === "error" ? "error" : "warn"](errorMessage, error);
    }
    return false;
  }
}

module.exports = { sendAuditLog };
