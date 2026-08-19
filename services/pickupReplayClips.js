"use strict";

const fetchDefault = require("node-fetch");

const DEFAULT_REPLAY_URL = "https://nonamepickup.servehalflife.com/pickup-replay.html";
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

function buildClipUrl(matchId, roundNumber, clip, baseUrl = DEFAULT_REPLAY_URL) {
  const url = new URL(baseUrl);
  url.searchParams.set("matchId", String(matchId));
  url.searchParams.set("round", String(roundNumber));
  url.searchParams.set("clipStart", Number(clip.clipStart).toFixed(3));
  url.searchParams.set("clipEnd", Number(clip.clipEnd).toFixed(3));
  url.searchParams.set("clipTitle", "Clean first pickup to cap");
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

    await channel.send({
      content: `:eyes: **Clean first pickup → cap** — [Watch clip](${clip.url})`,
    });
    db.prepare(`
      INSERT INTO pickup_replay_auto_clips (server_key, match_id, round_number, posted_at)
      VALUES (?, ?, ?, ?)
    `).run(String(serverKey), String(matchId), Number(roundNumber), Date.now());
    posted.push({ roundNumber: Number(roundNumber), clip });
  }
  return posted;
}

module.exports = {
  DEFAULT_REPLAY_URL,
  buildClipUrl,
  findCleanClipForRound,
  findCleanFirstPickupCap,
  parseEventsCsv,
  postCleanFirstPickupClips,
};
