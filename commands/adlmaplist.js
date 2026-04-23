// commands/adlmaplist.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin, guardChannel } = require("../lib/guards");
const { mirvLabel } = require("../lib/maps");

const fs   = require("fs");
const path = require("path");

const ROOT     = process.cwd();
const ADL_JSON = path.resolve(ROOT, "mappool_adl.json");

// --- local wrappers for ADL pool ---
function loadAdlMaps() {
  try {
    if (!fs.existsSync(ADL_JSON)) return [];
    const raw = fs.readFileSync(ADL_JSON, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function saveAdlMaps(arr) {
  try {
    fs.writeFileSync(ADL_JSON, JSON.stringify(arr, null, 2), "utf8");
  } catch (e) {
    console.error("[adlmaplist] write failed:", e);
  }
}

function adlGetMapList() {
  return loadAdlMaps();
}
function adlAddMap(name, tier, author = "") {
  const arr = loadAdlMaps();
  arr.push({ name, tier: parseInt(tier, 10) || 0, author });
  saveAdlMaps(arr);
  return arr;
}
function adlDeleteMapByIndex(index1) {
  const arr = loadAdlMaps();
  const idx = Math.max(0, Math.min(arr.length - 1, Number(index1) - 1));
  if (!arr.length || idx < 0 || idx >= arr.length) return { list: arr, removed: null };
  const removed = arr.splice(idx, 1)[0] || null;
  saveAdlMaps(arr);
  return { list: arr, removed };
}
function adlEditMap(index1, name, tier, author = "") {
  const arr = loadAdlMaps();
  const idx = Math.max(0, Math.min(arr.length - 1, Number(index1) - 1));
  if (!arr.length || idx < 0 || idx >= arr.length) return { list: arr, updated: null };
  arr[idx] = { ...arr[idx], name, tier: parseInt(tier, 10) || 0, author };
  saveAdlMaps(arr);
  return { list: arr, updated: arr[idx] };
}

// ----------------------------------------------------------------------

function register(reg, { config }) {
  const MAPS_CH   = String(config.channels.maps || "");
  const PICKUP_CH = String(config.channels.pickup || "");

  async function showAdlList(message) {
    const chId = String(message.channel?.id);
    if (chId !== MAPS_CH && chId !== PICKUP_CH) return;

    const list = adlGetMapList();
    if (!list.length) {
      return message.channel.send("No ADL maps found. Use `!adladdmap <name> <tier> [author]`.");
    }

    // 3-column layout
    const columns = 3;
    const perCol = Math.ceil(list.length / columns);
    const cols = Array.from({ length: columns }, (_, i) =>
      list.slice(i * perCol, (i + 1) * perCol)
    );

    const fmt = (arr, startIdx) =>
      arr.map((m, i) => {
        const idx = startIdx + i + 1;
        const auth = m.author ? ` — ${m.author}` : "";
        return `**${idx}.** ${m.name} (${mirvLabel(m.tier)}${auth})`;
      }).join("\n");

    const fields = cols.map((c, i) => ({
      name: " ",
      value: fmt(c, i * perCol) || "\u200b",
      inline: true,
    }));

    const emb = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle("ADL Map Pool")
      .addFields(fields)
      .setFooter({ text: `Total: ${list.length}` })
      .setTimestamp();

    await message.channel.send({ embeds: [emb] });
  }

  // --- Public list commands (pickup + maps channel) ---
  reg.set("adlmaplist", showAdlList);
  reg.set("adlmaps", showAdlList);

  // --- Admin-only modify commands (maps channel only) ---
  reg.set("adladdmap", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const name = args.shift();
    const tierArg = args.shift();
    if (!name || tierArg == null) {
      return message.channel.send("Usage: `!adladdmap <name> <tier> [author...]`");
    }
    const tier = parseInt(tierArg, 10);
    if (!Number.isFinite(tier) || tier < 0) {
      return message.channel.send("Tier must be a non-negative integer.");
    }
    const author = args.join(" ").trim();

    adlAddMap(name, tier, author);
    await showAdlList(message);
  });

  reg.set("adlmapdelete", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const idxArg = args.shift();
    const idx = parseInt(idxArg, 10);
    if (!Number.isFinite(idx) || idx < 1) {
      return message.channel.send("Usage: `!adlmapdelete <#>` (see `!adlmaplist`)");
    }

    adlDeleteMapByIndex(idx);
    await showAdlList(message);
  });
  reg.set("adlmapdel", reg.get("adlmapdelete"));
  reg.set("adlmapremove", reg.get("adlmapdelete"));

  reg.set("adlmapedit", async (message, args = []) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;

    const idxArg = args.shift();
    const name   = args.shift();
    const tierArg= args.shift();
    if (!idxArg || !name || tierArg == null) {
      return message.channel.send('Usage: `!adlmapedit <#> <name> <tier> [author...]`');
    }
    const idx  = parseInt(idxArg, 10);
    const tier = parseInt(tierArg, 10);
    if (!Number.isFinite(idx) || idx < 1) return message.channel.send("First arg must be a positive index.");
    if (!Number.isFinite(tier) || tier < 0) return message.channel.send("Tier must be non-negative integer.");

    const author = args.join(" ").trim();
    adlEditMap(idx, name, tier, author);
    await showAdlList(message);
  });

  reg.set("reloadadlmaps", async (message) => {
    if (!(await guardChannel(message, MAPS_CH))) return;
    if (!isAdmin(message)) return;
    await showAdlList(message);
  });
}

module.exports = { register };
