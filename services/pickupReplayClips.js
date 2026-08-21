"use strict";

const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { AttachmentBuilder } = require("discord.js");
const fetchDefault = require("node-fetch");
const { renderReplayClip } = require("./pickupReplayRenderer");

const DEFAULT_REPLAY_URL = "https://nonamepickup.servehalflife.com/pickup-replay.html";
const DEFAULT_LIVE_REPLAY_URL = "https://nonamepickup.servehalflife.com/pickup-live.html";
const DEFAULT_PADDING_SECONDS = 3;

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function parseEventsCsv(csv) {
  const lines = String(csv || "")
    .split(/\r?\n/)
    .filter(line => line.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  const index = new Map(header.map((name, position) => [name, position]));
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    return {
      timeMs: Number(fields[index.get("time_ms")] || 0),
      event: fields[index.get("event")] || "",
      actorSession: Number(fields[index.get("actor_session")] || 0),
      entity: Number(fields[index.get("entity")] || 0),
      text: fields[index.get("text")] || "",
    };
  }).filter(event => Number.isFinite(event.timeMs) && event.timeMs >= 0 && event.event);
}

function findCleanFirstPickupCap(events, { paddingSeconds = DEFAULT_PADDING_SECONDS } = {}) {
  const ordered = [...events].sort((a, b) => a.timeMs - b.timeMs);
  const pickup = ordered.find(event => event.event === "flag_pickup");
  if (!pickup) return null;

  // flag_pickup carries the authoritative actor/team transition, while the
  // objective stream identifies the exact flag entity being carried.
  const carried = ordered.find(event =>
    event.timeMs >= pickup.timeMs &&
    event.event === "flag_entity_carried" &&
    event.actorSession === pickup.actorSession &&
    event.entity > 0
  );
  if (!carried) return null;

  for (const event of ordered) {
    if (event.timeMs < carried.timeMs || event.entity !== carried.entity) continue;
    if (event.event === "flag_entity_dropped") return null;
    if (event.event === "flag_entity_base") {
      const start = Math.max(0, pickup.timeMs / 1000 - Math.max(0, Number(paddingSeconds) || 0));
      const end = Math.max(start, event.timeMs / 1000 + Math.max(0, Number(paddingSeconds) || 0));
      return {
        pickupTime: pickup.timeMs / 1000,
        capTime: event.timeMs / 1000,
        clipStart: start,
        clipEnd: end,
        actorSession: pickup.actorSession,
        entity: carried.entity,
        flag: pickup.text || "flag",
      };
    }
  }
  return null;
}

function findCleanPickupCaps(events, { paddingSeconds = DEFAULT_PADDING_SECONDS } = {}) {
  const ordered = [...events].sort((a, b) => a.timeMs - b.timeMs);
  const clips = [];
  let pickup = null;
  let carried = null;

  for (const event of ordered) {
    if (event.event === "flag_pickup") {
      pickup = event;
      carried = null;
      continue;
    }
    if (!pickup) continue;

    if (
      event.event === "flag_entity_carried" &&
      event.timeMs >= pickup.timeMs &&
      event.actorSession === pickup.actorSession &&
      event.entity > 0
    ) {
      carried = event;
      continue;
    }
    if (!carried || event.entity !== carried.entity || event.timeMs < carried.timeMs) continue;

    if (event.event === "flag_entity_dropped") {
      pickup = null;
      carried = null;
      continue;
    }
    if (event.event !== "flag_entity_base") continue;

    const padding = Math.max(0, Number(paddingSeconds) || 0);
    const start = Math.max(0, pickup.timeMs / 1000 - padding);
    const end = Math.max(start, event.timeMs / 1000 + padding);
    clips.push({
      pickupTime: pickup.timeMs / 1000,
      capTime: event.timeMs / 1000,
      clipStart: start,
      clipEnd: end,
      actorSession: pickup.actorSession,
      entity: carried.entity,
      flag: pickup.text || "flag",
    });
    pickup = null;
    carried = null;
  }

  return clips;
}

function buildClipUrl(matchId, roundNumber, clip, baseUrl = DEFAULT_REPLAY_URL) {
  const url = new URL(baseUrl);
  url.searchParams.set("matchId", String(matchId));
  url.searchParams.set("round", String(roundNumber));
  url.searchParams.set("clipStart", Number(clip.clipStart).toFixed(3));
  url.searchParams.set("clipEnd", Number(clip.clipEnd).toFixed(3));
  url.searchParams.set("clipTitle", "Clean first pickup to cap");
  return url.toString();
}

function buildLiveClipUrl(serverKey, matchId, roundNumber, clip, baseUrl = DEFAULT_LIVE_REPLAY_URL) {
  const url = new URL(baseUrl);
  url.searchParams.set("server", String(serverKey));
  url.searchParams.set("matchId", String(matchId));
  url.searchParams.set("round", String(roundNumber));
  url.searchParams.set("clipStart", Number(clip.clipStart).toFixed(3));
  url.searchParams.set("clipEnd", Number(clip.clipEnd).toFixed(3));
  url.searchParams.set("clipTitle", "Coast-to-coast");
  return url.toString();
}

async function findCleanClipForRound({
  matchId,
  roundNumber,
  fetchImpl = fetchDefault,
  replayUrl = DEFAULT_REPLAY_URL,
}) {
  const base = new URL(replayUrl);
  const eventsUrl = `${base.origin}/api/pickup-replays/viewer/${encodeURIComponent(matchId)}/${encodeURIComponent(roundNumber)}/files/events.csv`;
  const response = await fetchImpl(eventsUrl, { headers: { accept: "text/csv" } });
  if (!response.ok) throw new Error(`Replay events request failed (${response.status})`);
  const clip = findCleanFirstPickupCap(parseEventsCsv(await response.text()));
  return clip ? { ...clip, url: buildClipUrl(matchId, roundNumber, clip, replayUrl) } : null;
}

async function findLiveCleanClipForRound({
  serverKey,
  matchId,
  roundNumber,
  fetchImpl = fetchDefault,
  replayUrl = DEFAULT_LIVE_REPLAY_URL,
}) {
  const base = new URL(replayUrl);
  const snapshotUrl = `${base.origin}/api/pickup-live/viewer/${encodeURIComponent(serverKey)}/${encodeURIComponent(matchId)}/${encodeURIComponent(roundNumber)}/snapshot`;
  const response = await fetchImpl(snapshotUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Live replay snapshot request failed (${response.status})`);
  const snapshot = await response.json();
  const events = parseEventsCsv(snapshot?.files?.["events.csv"] || "");
  const clips = findCleanPickupCaps(events);
  const clip = clips.at(-1);
  return clip
    ? { ...clip, url: buildLiveClipUrl(serverKey, matchId, roundNumber, clip, replayUrl) }
    : null;
}

function ensureClipTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pickup_replay_auto_clips (
      server_key TEXT NOT NULL,
      match_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      posted_at INTEGER NOT NULL,
      PRIMARY KEY (server_key, match_id, round_number)
    );
  `);
}

function ensureLiveClipTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pickup_replay_live_clips (
      server_key TEXT NOT NULL,
      match_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      cap_time REAL NOT NULL,
      posted_at INTEGER NOT NULL,
      PRIMARY KEY (server_key, match_id, round_number, cap_time)
    );
  `);
}

function clipAttachmentName(matchId, roundNumber) {
  const safeMatch = String(matchId).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "replay";
  return `clean-first-pickup-${safeMatch}-round-${Number(roundNumber)}.webm`;
}

async function postCleanFirstPickupClips({
  client,
  channelId,
  db,
  serverKey,
  matchId,
  rounds,
  fetchImpl = fetchDefault,
  replayUrl = DEFAULT_REPLAY_URL,
  logger = console,
  attachWebm = false,
  renderClip = renderReplayClip,
  maxAttachmentBytes = 25_000_000,
}) {
  if (!channelId || !db || !Array.isArray(rounds) || !rounds.length) return [];
  ensureClipTable(db);
  const channel = await client.channels.fetch(channelId);
  if (!channel?.send) throw new Error("pickup clips channel is unavailable");
  const posted = [];

  for (const roundNumber of rounds) {
    const existing = db.prepare(`
      SELECT 1 FROM pickup_replay_auto_clips
      WHERE server_key=? AND match_id=? AND round_number=?
    `).get(String(serverKey), String(matchId), Number(roundNumber));
    if (existing) continue;

    let clip;
    try {
      clip = await findCleanClipForRound({ matchId, roundNumber, fetchImpl, replayUrl });
    } catch (error) {
      logger.warn?.(`[pickupReplayClips] unable to inspect ${matchId}/${roundNumber}: ${error.message}`);
      continue;
    }
    if (!clip) continue;

    let temporaryDirectory = null;
    let attachment = null;
    if (attachWebm) {
      try {
        temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "tfc-pickup-clip-"));
        const outputPath = path.join(temporaryDirectory, clipAttachmentName(matchId, roundNumber));
        await renderClip({
          url: clip.url,
          outputPath,
          matchId,
          roundNumber: Number(roundNumber),
          clip,
        });
        const stat = await fsp.stat(outputPath);
        if (!stat.size) throw new Error("renderer produced an empty WebM");
        if (stat.size > maxAttachmentBytes) {
          throw new Error(`WebM is ${stat.size} bytes; Discord limit is ${maxAttachmentBytes}`);
        }
        attachment = new AttachmentBuilder(outputPath, {
          name: clipAttachmentName(matchId, roundNumber),
        });
      } catch (error) {
        logger.warn?.(`[pickupReplayClips] WebM render failed for ${matchId}/${roundNumber}: ${error.message}`);
      }
    }

    try {
      await channel.send({
        content: `:eyes: **Clean first pickup → cap** — [Watch clip](${clip.url})`,
        ...(attachment ? { files: [attachment] } : {}),
      });
      db.prepare(`
        INSERT INTO pickup_replay_auto_clips (server_key, match_id, round_number, posted_at)
        VALUES (?, ?, ?, ?)
      `).run(String(serverKey), String(matchId), Number(roundNumber), Date.now());
      posted.push({ roundNumber: Number(roundNumber), clip });
    } finally {
      if (temporaryDirectory) {
        await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  return posted;
}

async function postLiveCleanPickupClip({
  client,
  channelId,
  db,
  serverKey,
  matchId,
  roundNumber,
  player,
  fetchImpl = fetchDefault,
  replayUrl = DEFAULT_LIVE_REPLAY_URL,
  logger = console,
  attachWebm = false,
  renderClip = renderReplayClip,
  maxAttachmentBytes = 25_000_000,
}) {
  if (!channelId || !db) return [];
  ensureLiveClipTable(db);
  const clip = await findLiveCleanClipForRound({
    serverKey,
    matchId,
    roundNumber,
    fetchImpl,
    replayUrl,
  });
  if (!clip) return [];

  const identity = [String(serverKey), String(matchId), Number(roundNumber), Number(clip.capTime)];
  const reservation = db.prepare(`
    INSERT OR IGNORE INTO pickup_replay_live_clips
      (server_key, match_id, round_number, cap_time, posted_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(...identity, Date.now());
  if (!reservation.changes) return [];

  let temporaryDirectory = null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.send) throw new Error("pickup clips channel is unavailable");

    let attachment = null;
    if (attachWebm) {
      try {
        temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "tfc-pickup-live-clip-"));
        const outputPath = path.join(temporaryDirectory, clipAttachmentName(matchId, roundNumber));
        await renderClip({
          url: clip.url,
          outputPath,
          matchId,
          roundNumber: Number(roundNumber),
          clip,
        });
        const stat = await fsp.stat(outputPath);
        if (!stat.size) throw new Error("renderer produced an empty WebM");
        if (stat.size > maxAttachmentBytes) {
          throw new Error(`WebM is ${stat.size} bytes; Discord limit is ${maxAttachmentBytes}`);
        }
        attachment = new AttachmentBuilder(outputPath, {
          name: clipAttachmentName(matchId, roundNumber),
        });
      } catch (error) {
        logger.warn?.(`[pickupReplayClips] live WebM render failed for ${matchId}/${roundNumber}: ${error.message}`);
      }
    }

    await channel.send({
      content: attachment
        ? `:eyes: **Coast-to-coast${player ? ` — ${player}` : ""}**`
        : `:eyes: **Coast-to-coast${player ? ` — ${player}` : ""}** — [Watch the live replay](${clip.url})`,
      ...(attachment ? { files: [attachment] } : {}),
    });
    return [{ roundNumber: Number(roundNumber), clip }];
  } catch (error) {
    db.prepare(`
      DELETE FROM pickup_replay_live_clips
      WHERE server_key=? AND match_id=? AND round_number=? AND cap_time=?
    `).run(...identity);
    logger.warn?.(`[pickupReplayClips] live coast-to-coast relay failed for ${matchId}/${roundNumber}: ${error.message}`);
    throw error;
  } finally {
    if (temporaryDirectory) {
      await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  DEFAULT_REPLAY_URL,
  DEFAULT_LIVE_REPLAY_URL,
  buildClipUrl,
  buildLiveClipUrl,
  findCleanClipForRound,
  findLiveCleanClipForRound,
  findCleanPickupCaps,
  findCleanFirstPickupCap,
  parseEventsCsv,
  postLiveCleanPickupClip,
  postCleanFirstPickupClips,
};
