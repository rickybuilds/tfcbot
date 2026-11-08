"use strict";

const axios = require("axios");
const STEAM_RE = /^STEAM_[0-5]:[01]:\d{1,20}$/;

function createBootcampApi({
  baseUrl = process.env.NONAME_URL || "https://nonamepickup.servehalflife.com",
  token = process.env.BOOTCAMP_DISCORD_API_TOKEN || "",
  client = axios,
  timeoutMs = 10_000
} = {}) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalizedBase)) throw new Error("NONAME_URL must be an HTTP(S) URL");
  const basePath = `${normalizedBase}/api/bootcamp`;
  const serviceHeaders = () => {
    if (!token) throw new Error("BOOTCAMP_DISCORD_API_TOKEN is not configured");
    return { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" };
  };
  const requestOptions = headers => ({ headers, timeout: timeoutMs });

  return {
    baseUrl: normalizedBase,
    async latestEventId() {
      const response = await client.get(`${basePath}/integrations/discord/events/cursor`, requestOptions(serviceHeaders()));
      const id = Number(response.data?.latestId);
      if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid Bootcamp event cursor response");
      return id;
    },
    async events(afterId = 0, limit = 100) {
      if (!Number.isSafeInteger(Number(afterId)) || Number(afterId) < 0) throw new Error("Invalid Bootcamp event cursor");
      if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 200) throw new Error("Invalid Bootcamp event limit");
      const response = await client.get(`${basePath}/integrations/discord/events`, {
        ...requestOptions(serviceHeaders()), params: { after_id: Number(afterId), limit: Number(limit) }
      });
      if (!Array.isArray(response.data?.events)) throw new Error("Invalid Bootcamp event response");
      return response.data.events;
    },
    async recomputeLicense(steamId) {
      if (!STEAM_RE.test(String(steamId || ""))) throw new Error("Invalid Steam ID");
      const response = await client.post(`${basePath}/integrations/discord/licenses/recompute`, { steamId }, requestOptions(serviceHeaders()));
      if (!response.data?.license || typeof response.data.license.level !== "string") throw new Error("Invalid Bootcamp license response");
      return response.data.license;
    },
    async cosignLicense(steamId, mentorDiscordId) {
      if (!STEAM_RE.test(String(steamId || ""))) throw new Error("Invalid Steam ID");
      if (!/^\d{17,20}$/.test(String(mentorDiscordId || ""))) throw new Error("Invalid mentor Discord ID");
      const response = await client.post(`${basePath}/integrations/discord/licenses/cosign`,
        { steamId, mentorDiscordId }, requestOptions(serviceHeaders()));
      if (response.data?.cosigned !== true) throw new Error("Invalid Bootcamp co-sign response");
      return response.data;
    },
    async player(steamId) {
      if (!STEAM_RE.test(String(steamId || ""))) throw new Error("Invalid Steam ID");
      const response = await client.get(`${basePath}/players/${encodeURIComponent(steamId)}`, requestOptions({}));
      return response.data;
    },
    async challenge() {
      const response = await client.get(`${basePath}/challenge/current`, requestOptions({}));
      return response.data;
    }
  };
}

module.exports = { createBootcampApi };
