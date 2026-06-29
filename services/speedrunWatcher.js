// services/speedrunWatcher.js

const { EmbedBuilder } = require("discord.js");
const DEFAULT_POLL_MS = 20_000;

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

  logger.info?.("[speedrunWatcher] ensured speedrun_wr_announcements table");
}

async function getCurrentWorldRecords(pool) {
  const [rows] = await pool.query(`
    SELECT r.map, r.class_id, r.class_name, r.steamid, r.player_name, r.best_time_ms
    FROM speedrun_records r
    INNER JOIN (
      SELECT map, class_id, MIN(best_time_ms) AS best_time_ms
      FROM speedrun_records
      WHERE best_time_ms IS NOT NULL
        AND best_time_ms > 0
      GROUP BY map, class_id
    ) wr
      ON wr.map = r.map
     AND wr.class_id = r.class_id
     AND wr.best_time_ms = r.best_time_ms
    WHERE r.best_time_ms IS NOT NULL
      AND r.best_time_ms > 0
    ORDER BY r.map, r.class_id, r.updated_at ASC
  `);

  // If multiple players tie WR, only announce the first stable row per map/class.
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.map}:${row.class_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getAnnouncement(pool, map, classId) {
  const [rows] = await pool.query(
    `
    SELECT map, class_id, steamid, player_name, best_time_ms
    FROM speedrun_wr_announcements
    WHERE map = ?
      AND class_id = ?
    LIMIT 1
    `,
    [map, classId]
  );

  return rows[0] || null;
}

function isNewWorldRecord(current, previous) {
  if (!previous) return true;

  return (
    String(current.steamid) !== String(previous.steamid) ||
    Number(current.best_time_ms) !== Number(previous.best_time_ms)
  );
}

async function saveAnnouncement(pool, wr) {
  await pool.query(
    `
    INSERT INTO speedrun_wr_announcements
      (map, class_id, steamid, player_name, best_time_ms, announced_at)
    VALUES (?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      steamid = VALUES(steamid),
      player_name = VALUES(player_name),
      best_time_ms = VALUES(best_time_ms),
      announced_at = NOW()
    `,
    [wr.map, wr.class_id, wr.steamid, wr.player_name, wr.best_time_ms]
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

function buildWorldRecordEmbed(wr) {
  const cls = className(wr.class_id, wr.class_name);
  const replayClass = cls.toLowerCase();

  const baseUrl = (process.env.NONAME_URL || "https://nonamepickup.servehalflife.com")
    .replace(/\/$/, "");

  const mapUrl = `${baseUrl}/speedrun-map.html?map=${encodeURIComponent(wr.map)}`;

  return new EmbedBuilder()
    .setTitle("🏆 NEW NONAME SPEEDRUN RECORD")
    .setURL(mapUrl)
    .setColor(0xffc107)
    .addFields(
      { name: "Player", value: String(wr.player_name || "Unknown"), inline: true },
      { name: "Class", value: cls, inline: true },
      { name: "Map", value: String(wr.map), inline: true },
      { name: "Time", value: formatTime(wr.best_time_ms), inline: true },
      { name: "SteamID", value: String(wr.steamid || "Unknown"), inline: false },
      { name: "Replay", value: `\`/replay ${replayClass} 1\``, inline: false }
    )
    .setTimestamp(new Date());
}

async function announceWorldRecord({ client, channel, wr, logger = console }) {
  const embed = buildWorldRecordEmbed(wr);

  await channel.send({ embeds: [embed] });

  logger.info?.(
    `[speedrunWatcher] announced WR ${wr.map}/${wr.class_id}: ${wr.player_name} ${wr.best_time_ms}ms`
  );
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

      if (!isNewWorldRecord(wr, previous)) continue;

      await announceWorldRecord({ client, channel, wr, logger });
      await saveAnnouncement(pool, wr);
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
    logger.warn?.(
      `[speedrunWatcher] could not ensure announcement table, continuing anyway: ${err.message}`
    );
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
};
