// services/speedrunWatcher.js

const { EmbedBuilder } = require("discord.js");
const DEFAULT_POLL_MS = 20_000;
const ACTIVE_SPEEDRUN_RULESET = 2;
const REPLAY_PENDING_LABEL = "**Replay coming soon…**";

// MySQL contains some legacy player names whose UTF-8 bytes were decoded as
// Windows-1252 before they were stored (for example, "ă" became "Äƒ").
// Recreate those original bytes at the read boundary without altering names
// that are already valid Unicode.
const WINDOWS_1252_BYTES = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84],
  ["…", 0x85], ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88],
  ["‰", 0x89], ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c],
  ["Ž", 0x8e], ["‘", 0x91], ["’", 0x92], ["“", 0x93],
  ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b],
  ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f],
]);

const MOJIBAKE_MARKERS = /[ÂÃÄÅÆÈÎÐâƒ™�]/g;

function mojibakeScore(value) {
  return (String(value).match(MOJIBAKE_MARKERS) || []).length;
}

function repairLegacyUtf8(value) {
  const original = String(value || "");
  if (!mojibakeScore(original)) return original;

  const bytes = [];
  for (const character of original) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xff) {
      bytes.push(codePoint);
    } else if (WINDOWS_1252_BYTES.has(character)) {
      bytes.push(WINDOWS_1252_BYTES.get(character));
    } else {
      return original;
    }
  }

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes)
    );
    return mojibakeScore(repaired) < mojibakeScore(original) ? repaired : original;
  } catch {
    return original;
  }
}

const CLASS_NAMES = {
  1: "Scout",
  2: "Sniper",
  3: "Soldier",
  4: "Demoman",
  5: "Medic",
  6: "HWGuy",
  7: "Pyro",
  8: "Spy",
  9: "Engineer",
};

let interval = null;
let running = false;

function formatTime(ms) {
  const totalMs = Number(ms || 0);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function className(classId, fallback) {
  return fallback || CLASS_NAMES[classId] || `Class ${classId}`;
}

async function ensureAnnouncementTable(pool, logger = console) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS speedrun_wr_announcements (
      map VARCHAR(128) NOT NULL,
      class_id INT NOT NULL,
      steamid VARCHAR(64) NOT NULL,
      player_name VARCHAR(128) NOT NULL,
      best_time_ms INT NOT NULL,
      announced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (map, class_id)
    )
  `);

  // The production Speedwatch user can CREATE tables but cannot ALTER this
  // legacy table. Keep it intact and store the expanded state in a v2 table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS speedrun_wr_announcements_v2 (
      map VARCHAR(128) NOT NULL,
      class_id INT NOT NULL,
      steamid VARCHAR(64) NOT NULL,
      player_name VARCHAR(128) NOT NULL,
      best_time_ms INT NOT NULL,
      discord_message_id VARCHAR(32) NULL,
      discord_channel_id VARCHAR(32) NULL,
      replay_run_id BIGINT UNSIGNED NULL,
      announced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (map, class_id)
    )
  `);

  await pool.query(`
    INSERT IGNORE INTO speedrun_wr_announcements_v2
      (map, class_id, steamid, player_name, best_time_ms, announced_at)
    SELECT
      map,
      class_id,
      steamid,
      player_name,
      best_time_ms,
      announced_at
    FROM speedrun_wr_announcements
  `);

  logger.info?.("[speedrunWatcher] ensured speedrun_wr_announcements_v2 table");
}

async function getCurrentWorldRecords(pool) {
  const [rows] = await pool.query(`
    SELECT
      r.map,
      r.class_id,
      r.class_name,
      r.steamid,
      r.player_name,
      r.best_time_ms,
      l.discord_id,
      (
        SELECT sr.id
        FROM speedrun_runs sr
        JOIN speedrun_ghosts sg
          ON sg.run_id = sr.id AND sg.is_complete = 1
        WHERE sr.map = r.map
          AND sr.class_id = r.class_id
          AND sr.steamid = r.steamid
          AND sr.ruleset = ?
          AND sr.time_ms = r.best_time_ms
        ORDER BY sr.created_at DESC, sr.id DESC
        LIMIT 1
      ) AS run_id
    FROM speedrun_records r
    LEFT JOIN speedrun_player_links l
      ON l.steamid = r.steamid
    INNER JOIN (
      SELECT map, class_id, MIN(best_time_ms) AS best_time_ms
      FROM speedrun_records
      WHERE ruleset = ?
        AND best_time_ms IS NOT NULL
        AND best_time_ms > 0
      GROUP BY map, class_id
    ) wr
      ON wr.map = r.map
     AND wr.class_id = r.class_id
     AND wr.best_time_ms = r.best_time_ms
    WHERE r.ruleset = ?
      AND r.best_time_ms IS NOT NULL
      AND r.best_time_ms > 0
    ORDER BY r.map, r.class_id, r.updated_at ASC
  `, [
    ACTIVE_SPEEDRUN_RULESET,
    ACTIVE_SPEEDRUN_RULESET,
    ACTIVE_SPEEDRUN_RULESET,
  ]);

  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.map}:${row.class_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => ({
    ...row,
    player_name: repairLegacyUtf8(row.player_name),
  }));
}

async function getAnnouncement(pool, map, classId) {
  const [rows] = await pool.query(
    `
    SELECT
      map,
      class_id,
      steamid,
      player_name,
      best_time_ms,
      discord_message_id,
      discord_channel_id,
      replay_run_id
    FROM speedrun_wr_announcements_v2
    WHERE map = ?
      AND class_id = ?
    LIMIT 1
    `,
    [map, classId]
  );

  if (!rows[0]) return null;

  return {
    ...rows[0],
    player_name: repairLegacyUtf8(rows[0].player_name),
  };
}

function isNewWorldRecord(current, previous) {
  if (!previous) return true;

  return (
    String(current.steamid) !== String(previous.steamid) ||
    Number(current.best_time_ms) !== Number(previous.best_time_ms)
  );
}

async function saveAnnouncement(pool, wr, message, channel) {
  await pool.query(
    `
    INSERT INTO speedrun_wr_announcements_v2
      (
        map,
        class_id,
        steamid,
        player_name,
        best_time_ms,
        discord_message_id,
        discord_channel_id,
        replay_run_id,
        announced_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      steamid = VALUES(steamid),
      player_name = VALUES(player_name),
      best_time_ms = VALUES(best_time_ms),
      discord_message_id = VALUES(discord_message_id),
      discord_channel_id = VALUES(discord_channel_id),
      replay_run_id = VALUES(replay_run_id),
      announced_at = NOW()
    `,
    [
      wr.map,
      wr.class_id,
      wr.steamid,
      wr.player_name,
      wr.best_time_ms,
      message.id,
      channel.id,
      getReplayRunId(wr),
    ]
  );
}

async function markReplayAvailable(pool, wr, runId) {
  await pool.query(
    `
    UPDATE speedrun_wr_announcements_v2
    SET replay_run_id = ?
    WHERE map = ?
      AND class_id = ?
      AND steamid = ?
      AND best_time_ms = ?
    `,
    [runId, wr.map, wr.class_id, wr.steamid, wr.best_time_ms]
  );
}

async function findSpeedrunChannel(client, config = {}) {
  const configuredId =
    config.speedrunChannelId ||
    config.SPEEDRUN_CHANNEL_ID ||
    process.env.SPEEDRUN_CHANNEL_ID;

  if (configuredId) {
    const channel = await client.channels.fetch(configuredId).catch(() => null);
    if (channel) return channel;
  }

  const name =
    config.speedrunChannelName ||
    config.SPEEDRUN_CHANNEL_NAME ||
    process.env.SPEEDRUN_CHANNEL_NAME ||
    "🏃-speedrunners";

  return client.channels.cache.find((ch) => ch.name === name) || null;
}

function formatDelta(ms) {
  const totalMs = Number(ms || 0);
  const seconds = Math.floor(totalMs / 1000);
  const millis = totalMs % 1000;

  return `${seconds}.${String(millis).padStart(3, "0")}`;
}

function getReplayRunId(wr) {
  const runId = Number(wr.run_id ?? wr.runId ?? wr.replay_run_id);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

function getReplayUrl(runId) {
  if (!runId) return null;

  const baseUrl = (process.env.NONAME_URL || "https://nonamepickup.servehalflife.com")
    .replace(/\/$/, "");

  return `${baseUrl}/speedrun-replay.html?runId=${encodeURIComponent(runId)}`;
}

function getReplayLabel(runId) {
  const replayUrl = getReplayUrl(runId);
  return replayUrl
    ? `**[View Replay](${replayUrl})**`
    : REPLAY_PENDING_LABEL;
}

function buildWorldRecordEmbed(wr, previous = null) {
  const cls = className(wr.class_id, wr.class_name);

  const baseUrl = (process.env.NONAME_URL || "https://nonamepickup.servehalflife.com")
    .replace(/\/$/, "");

  const mapUrl = `${baseUrl}/speedrun-map.html?map=${encodeURIComponent(wr.map)}`;

  const playerKey = wr.discord_id || wr.steamid;
  const playerUrl = `${baseUrl}/speedrun-player.html?id=${encodeURIComponent(playerKey)}`;

  const playerName = String(wr.player_name || "Unknown");
  const mapName = String(wr.map || "Unknown");

  const runId = getReplayRunId(wr);
  const replayLabel = getReplayLabel(runId);

  const diffMs = previous
    ? Number(previous.best_time_ms) - Number(wr.best_time_ms)
    : 0;

  const comparison =
    previous && diffMs > 0
      ? ` **(-${formatDelta(diffMs)}s vs ${previous.player_name})**`
      : "";

  return new EmbedBuilder()
    .setTitle("🏆 NEW NONAME SPEEDRUN RECORD")
    .setURL(mapUrl)
    .setColor(0xffc107)
    .setDescription(
        `**[${mapName}](${mapUrl})** • **${cls}** • ${replayLabel}\n` +
        `**[${playerName}](${playerUrl})** • ⏱️ **${formatTime(wr.best_time_ms)}**${comparison}`
    )
    .setFooter({ text: `SteamID: ${wr.steamid || "Unknown"}` })
    .setTimestamp(new Date());
}

async function announceWorldRecord({ client, channel, wr, previous = null, logger = console }) {
  const embed = buildWorldRecordEmbed(wr, previous);

  const message = await channel.send({ embeds: [embed] });

  logger.info?.(
    `[speedrunWatcher] announced WR ${wr.map}/${wr.class_id}: ${wr.player_name} ${wr.best_time_ms}ms`
  );

  return message;
}

async function addReplayToAnnouncement({
  client,
  channel,
  pool,
  wr,
  announcement,
  logger = console,
}) {
  const runId = getReplayRunId(wr);
  if (!runId || !announcement.discord_message_id) return false;

  let messageChannel = channel;
  if (
    announcement.discord_channel_id &&
    String(announcement.discord_channel_id) !== String(channel.id)
  ) {
    messageChannel = await client.channels
      .fetch(announcement.discord_channel_id)
      .catch(() => null);
  }

  if (!messageChannel?.messages?.fetch) {
    logger.warn?.(
      `[speedrunWatcher] cannot find announcement channel for ${wr.map}/${wr.class_id}`
    );
    return false;
  }

  const message = await messageChannel.messages.fetch(
    announcement.discord_message_id
  );
  const existingEmbed = message.embeds?.[0];
  const description = existingEmbed?.description || "";
  const replayLabel = getReplayLabel(runId);

  // Discord may have accepted the edit just before a restart or database
  // error. In that case, only the persisted replay state still needs repair.
  if (description.includes(replayLabel)) {
    await markReplayAvailable(pool, wr, runId);
    return true;
  }

  if (!description.includes(REPLAY_PENDING_LABEL)) {
    logger.warn?.(
      `[speedrunWatcher] replay placeholder missing from message ${announcement.discord_message_id}`
    );
    return false;
  }

  const updatedEmbed = EmbedBuilder.from(existingEmbed).setDescription(
    description.replace(REPLAY_PENDING_LABEL, replayLabel)
  );

  await message.edit({ embeds: [updatedEmbed] });
  await markReplayAvailable(pool, wr, runId);

  logger.info?.(
    `[speedrunWatcher] added replay ${runId} to announcement ${announcement.discord_message_id}`
  );

  return true;
}

async function pollSpeedrunEvents({ client, pool, config = {}, logger = console }) {
  if (running) return;
  running = true;

  try {
    const channel = await findSpeedrunChannel(client, config);

    if (!channel) {
      logger.warn?.("[speedrunWatcher] speedrunners channel not found");
      return;
    }

    const records = await getCurrentWorldRecords(pool);

    for (const wr of records) {
      const previous = await getAnnouncement(pool, wr.map, wr.class_id);

      if (!isNewWorldRecord(wr, previous)) {
        if (!getReplayRunId(previous) && getReplayRunId(wr)) {
          await addReplayToAnnouncement({
            client,
            channel,
            pool,
            wr,
            announcement: previous,
            logger,
          });
        }
        continue;
      }

      const message = await announceWorldRecord({
        client,
        channel,
        wr,
        previous,
        logger,
      });
      await saveAnnouncement(pool, wr, message, channel);
    }
  } catch (err) {
    logger.error?.("[speedrunWatcher] poll failed:", err);
  } finally {
    running = false;
  }
}

async function startSpeedrunWatcher({ client, pool, config = {}, logger = console }) {
  const enabled =
    config.speedrunWatcherEnabled ??
    config.SPEEDRUN_WATCHER_ENABLED ??
    process.env.SPEEDRUN_WATCHER_ENABLED ??
    "true";

  if (String(enabled).toLowerCase() === "false") {
    logger.info?.("[speedrunWatcher] disabled");
    return;
  }

  if (!client || !pool) {
    logger.warn?.("[speedrunWatcher] missing client or pool");
    return;
  }

  const pollMs = Number(
    config.speedrunWatcherPollMs ||
      config.SPEEDRUN_WATCHER_POLL_MS ||
      process.env.SPEEDRUN_WATCHER_POLL_MS ||
      DEFAULT_POLL_MS
  );

  try {
    await ensureAnnouncementTable(pool, logger);
  } catch (err) {
    logger.error?.(
      `[speedrunWatcher] could not ensure announcement table; watcher not started: ${err.message}`
    );
    return;
  }

  logger.info?.(`[speedrunWatcher] starting, poll=${pollMs}ms`);

  await pollSpeedrunEvents({ client, pool, config, logger });

  interval = setInterval(() => {
    pollSpeedrunEvents({ client, pool, config, logger });
  }, pollMs);
}

function stopSpeedrunWatcher(logger = console) {
  if (interval) {
    clearInterval(interval);
    interval = null;
    logger.info?.("[speedrunWatcher] stopped");
  }
}

module.exports = {
  startSpeedrunWatcher,
  stopSpeedrunWatcher,
  pollSpeedrunEvents,
  formatTime,
  formatDelta,
  repairLegacyUtf8,
  buildWorldRecordEmbed,
};
