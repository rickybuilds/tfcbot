// commands/maplist.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const sqlite3 = require("sqlite3").verbose();
const path = require("path"); // ✅ needed for DB path
const { isAdmin, guardChannel } = require("../lib/guards");
const {
  getMapList, addMap, deleteMapByIndex, editMap, loadMapsFromDisk, mirvLabel,
} = require("../lib/maps");

function register(reg, { config, state }) {
  const MAPS_CH   = String(config.channels.maps || "");
  const PICKUP_CH = String(config.channels.pickup || "");

  function refreshMapsInState() {
    state.maps = loadMapsFromDisk();
  }

  /* ------------------------- Helper: get map play counts ------------------------- */
  async function getMapPlayCounts() {
    return new Promise((resolve, reject) => {
      const dbPath = path.resolve("/root/tfcbot/elo.db");
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) return reject(err);
      });

const sql = `
  SELECT
    LOWER(
      RTRIM(
        CASE
          -- strip "_b1", "_b12", "_b9" style suffixes
          WHEN map_name GLOB '*_b[0-9]' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 2)
          WHEN map_name GLOB '*_b[0-9][0-9]' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 3)
          -- strip "_rc1" style suffixes
          WHEN map_name GLOB '*_rc[0-9]' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 3)
          WHEN map_name GLOB '*_rc[0-9][0-9]' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 4)
          -- strip "_beta" or "_test" (no trailing number)
          WHEN map_name LIKE '%_beta' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 5)
          WHEN map_name LIKE '%_test' THEN SUBSTR(map_name, 1, LENGTH(map_name) - 5)
          ELSE map_name
        END,
        '_'
      )
    ) AS base_map,
    COUNT(*) AS count
  FROM matches
  WHERE status = 'completed'
  GROUP BY base_map;
`;

      db.all(sql, [], (err, rows) => {
        if (err) {
          db.close();
          return reject(err);
        }
        const mapCounts = {};
        rows.forEach(r => {
          mapCounts[r.base_map] = r.count;
        });
        db.close();
        resolve(mapCounts);
      });
    });
  }

  /* -------------------------- !maplist (grouped) -------------------------- */
  async function showList(message) {
    const chId = String(message.channel?.id);
    if (chId !== MAPS_CH && chId !== PICKUP_CH) return;

    const list = getMapList();
    const playCounts = await getMapPlayCounts(); // 🧮 now works cleanly

    if (!list.length) {
      return message.channel.send("No maps found. Use `!addmap <name> <mirvcount> <tier>` to add.");
    }

    // 🧭 Group maps by tier (1,2,3,other)
    const tiers = { 1: [], 2: [], 3: [], other: [] };
    list.forEach((m, i) => {
      const tier = Number(m.tier) || 0;
      const mirv = Number(m.mirv) || 0;
      const entry = { ...m, idx: i + 1, tier, mirv };
      if (tier === 1) tiers[1].push(entry);
      else if (tier === 2) tiers[2].push(entry);
      else if (tier === 3) tiers[3].push(entry);
      else tiers.other.push(entry);
    });

    function buildTierFields(arr, playCounts = {}) {
      if (!arr.length) return [];

      // Calc max widths for padding (adjust buffers as needed)
      const maxMapLen = Math.max(...arr.map(m => (`${m.idx}. ${m.name}`).length), 25); // e.g., for "14. shutdown2_lg"
      const maxMirvLen = Math.max(...arr.map(m => String(m.mirv).length), 1) + 2; // Room for "Mirv" header
      const maxPlayedLen = Math.max(6, ...(Object.values(playCounts).map(p => String(p).length) || [])) + 2; // "Played" + up to 100+

      // Build paired rows with padding
      const mapsCol = [];
      const mirvCol = [];
      const playedCol = [];

      for (let i = 0; i < arr.length; i += 2) {
        const left = arr[i];
        const right = arr[i + 1] || { idx: '', name: '', mirv: '', /* empty for padding */ };

        // Map column: Left-align, padEnd, bold index
        const leftMap = left ? `**${left.idx}.** ${left.name.substring(0, maxMapLen - 4)}` : ''; // Truncate if mega-long
        const rightMap = right.idx ? `**${right.idx}.** ${right.name.substring(0, maxMapLen - 4)}` : '';
        mapsCol.push(
          `${leftMap.padEnd(maxMapLen)}${rightMap ? `\n${rightMap.padEnd(maxMapLen)}` : ''}`
        );

        // Mirv: Right-align numbers, padStart
const leftMirv = left.mirv !== undefined && left.mirv !== null
  ? String(left.mirv).padStart(maxMirvLen - 2, ' ')
  : ' ';

const rightMirv = right.mirv !== undefined && right.mirv !== null
  ? String(right.mirv).padStart(maxMirvLen - 2, ' ')
  : ' ';

        mirvCol.push(
          `${leftMirv}${rightMirv ? `\n${rightMirv}` : ''}`
        );

        // Played: Right-align, padStart (use playCounts)
// Normalize name (treat hyphens and underscores the same)
function normalizeName(name = "") {
  return name
    .toLowerCase()
    .replace(/[-_](b|rc|beta|test)[0-9]*$/, "")
    .replace(/[-_]$/, "")
    .replace(/[-_]/g, ""); // unify underscores and hyphens
}

const baseLeft = normalizeName(left.name);
const baseRight = right.name ? normalizeName(right.name) : "";

// Match playCounts keys with normalized version
const leftPlayKey = Object.keys(playCounts).find(k => normalizeName(k) === baseLeft);
const rightPlayKey = Object.keys(playCounts).find(k => normalizeName(k) === baseRight);

const leftPlays = String(playCounts[leftPlayKey] || 0).padStart(maxPlayedLen - 2, ' ');
const rightPlays = rightPlayKey
  ? String(playCounts[rightPlayKey] || 0).padStart(maxPlayedLen - 2, ' ')
  : '';


playedCol.push(`${leftPlays}${rightPlays ? `\n${rightPlays}` : ''}`);

      }

      // Join columns (bold headers, no extra \n/separator line before data to tighten spacing)
const mapsStr = `${'─'.repeat(maxMapLen)}\n${mapsCol.join('\n')}`;
const mirvStr = `${'─'.repeat(maxMirvLen)}\n${mirvCol.join('\n')}`;
const playedStr = `${'─'.repeat(maxPlayedLen)}\n${playedCol.join('\n')}`;


return [
  { name: "Map", value: mapsStr || " ", inline: true },
  { name: "Mirv", value: mirvStr || " ", inline: true },
  { name: "Played", value: playedStr || " ", inline: true }
];
    }

    function makeEmbed(title, color, arr, playCounts) {
      if (!arr.length) return null;
      return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .addFields(buildTierFields(arr, playCounts))
        .setFooter({ 
          text: `Total: ${arr.length} maps` 
        })
        .setTimestamp();
    }

    // 🎨 Build individual embeds per tier
    const embeds = [
      makeEmbed("Tier 1 Maps", 0x57f287, tiers[1], playCounts), // green
      makeEmbed("Tier 2 Maps", 0x3498db, tiers[2], playCounts), // blue
      makeEmbed("Tier 3 Maps", 0xed4245, tiers[3], playCounts), // red
      makeEmbed("Unassigned / Other Maps", 0x99aab5, tiers.other, playCounts), // grey fallback
    ].filter(Boolean);

    await message.channel.send({ embeds });
  }

  reg.set("maplist", showList);
  reg.set("maps", showList); // alias

  /* ------------------------------ !addmap ------------------------------ */
  reg.set("addmap", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const name = args.shift();
    const mirvArg = args.shift();
    const tierArg = args.shift();

    if (!name || mirvArg == null || tierArg == null) {
      return message.channel.send("Usage: `!addmap <name> <mirvcount> <tier>`");
    }

    const mirv = parseInt(mirvArg, 10);
    const tier = parseInt(tierArg, 10);

    if (!Number.isFinite(mirv) || mirv < 0)
      return message.channel.send("Mirv count must be a non-negative integer.");
    if (!Number.isFinite(tier) || tier < 0)
      return message.channel.send("Tier must be a non-negative integer.");

    addMap(name, mirv, tier);
    refreshMapsInState();
    await showList(message);
  });
  reg.set("mapadd", reg.get("addmap"));

  /* ----------------------------- !mapdelete ----------------------------- */
  reg.set("mapdelete", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const idxArg = args.shift();
    const idx = parseInt(idxArg, 10);
    if (!Number.isFinite(idx) || idx < 1)
      return message.channel.send("Usage: `!mapdelete <#>` (use `!maplist` to see numbers)");

    deleteMapByIndex(idx);
    refreshMapsInState();
    await showList(message);
  });
  reg.set("mapdel", reg.get("mapdelete"));
  reg.set("mapremove", reg.get("mapdelete"));

  /* ------------------------------ !mapedit ------------------------------ */
  reg.set("mapedit", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const idxArg = args.shift();
    const name   = args.shift();
    const mirvArg= args.shift();
    const tierArg= args.shift();

    if (!idxArg || !name || mirvArg == null || tierArg == null)
      return message.channel.send('Usage: `!mapedit <#> <name> <mirvcount> <tier>`');

    const idx  = parseInt(idxArg, 10);
    const mirv = parseInt(mirvArg, 10);
    const tier = parseInt(tierArg, 10);

    if (!Number.isFinite(idx) || idx < 1)
      return message.channel.send("First arg must be a positive index.");
    if (!Number.isFinite(mirv) || mirv < 0)
      return message.channel.send("Mirv count must be a non-negative integer.");
    if (!Number.isFinite(tier) || tier < 0)
      return message.channel.send("Tier must be a non-negative integer.");

    editMap(idx, name, mirv, tier);
    refreshMapsInState();
    await showList(message);
  });

  /* ----------------------------- !reloadmaps ----------------------------- */
  reg.set("reloadmaps", async (message) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;
    refreshMapsInState();
    await showList(message);
  });
}

module.exports = { register };