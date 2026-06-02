"use strict";

const fs = require("fs");
const path = require("path");
const { armed } = require("../services/autoRecap");
const { isAdmin } = require("../lib/guards");
const { getMapList } = require("../lib/maps");

const MAP_FILE = path.resolve(__dirname, "..", "mapCaptures.json");

function loadCaps() {
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCaps(data) {
  fs.writeFileSync(MAP_FILE, JSON.stringify(data, null, 2));
}

function getCurrentMap() {
  const first = [...armed.values()][0];
  return first?.lastMapSeen || first?.map || null;
}

function cleanQuotes(s) {
  return String(s || "").replace(/^"|"$/g, "");
}

function normalizeMapName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[-_](b|rc|beta|test)[0-9]*$/, "")
    .replace(/[-_]$/, "")
    .replace(/[-_]/g, "");
}

function findCustomRules(json, mapName) {
  const maps = json.maps || json;
  const wanted = normalizeMapName(mapName);
  const key = Object.keys(maps).find(k => normalizeMapName(k) === wanted);
  return key ? maps[key] : [];
}

function buildStatus(json, mapName) {
  const rules = findCustomRules(json, mapName);

  if (!rules.length) {
    return "GLOBAL: Team 1/2 dropoff";
  }

  return rules
    .map(r => {
      const team = r.team || r.teamFrom || "?";
      const score = r.scoreValue || r.points || 10;
      return `${team}: ${r.trigger} (${score})`;
    })
    .join(" | ");
}

async function register(reg, deps) {
  reg.set("mapcaps", async (message, args) => {
    if (!isAdmin(message)) return;

    const json = loadCaps();

    // !mapcaps current or !mapcaps <map>
    if (args.length) {
      const map =
        args[0].toLowerCase() === "current"
          ? getCurrentMap()
          : args[0];

      if (!map) return message.channel.send("Could not determine current map.");

      const rules = findCustomRules(json, map);

      if (!rules.length) {
        return message.channel.send(
          `Map caps for **${map}**:\n` +
          `Uses GLOBAL default:\n` +
          "`Team 1 dropoff` -> Blue\n" +
          "`Team 2 dropoff` -> Red"
        );
      }

      return message.channel.send(
        `Map caps for **${map}**:\n` +
        rules.map((x, i) =>
          `${i + 1}. ${x.team} -> "${x.trigger}" (${x.scoreValue || 10} pts)`
        ).join("\n")
      );
    }

    // !mapcaps = full tiered map list
    const list = getMapList();

    if (!list.length) {
      return message.channel.send("No maps found in map list.");
    }

    const tiers = { 1: [], 2: [], 3: [], other: [] };

    for (const m of list) {
      const tier = Number(m.tier) || 0;
      const status = buildStatus(json, m.name);

      const line = `${m.name.padEnd(24)} ${status}`;

      if (tier === 1) tiers[1].push(line);
      else if (tier === 2) tiers[2].push(line);
      else if (tier === 3) tiers[3].push(line);
      else tiers.other.push(line);
    }

    const lines = [];

    function addTier(title, arr) {
      if (!arr.length) return;
      lines.push("");
      lines.push(`${title}`);
      lines.push("```");
      lines.push("Map                      Capture Rule");
      lines.push("------------------------ ------------");
      arr.forEach(x => lines.push(x));
      lines.push("```");
    }

async function sendTier(title, arr) {

  if (!arr.length) return;

  const header =
`${title}
\`\`\`
Map                      Capture Rule
------------------------ ------------`;

  let current = header;

  for (const line of arr) {

    const candidate =
      current +
      "\n" +
      line;

    if ((candidate + "\n```").length > 1800) {

      await message.channel.send(
        current + "\n```"
      );

      current = header + "\n" + line;

    } else {

      current = candidate;

    }

  }

  await message.channel.send(
    current + "\n```"
  );

}

await sendTier("Tier 1 Maps", tiers[1]);
await sendTier("Tier 2 Maps", tiers[2]);
await sendTier("Tier 3 Maps", tiers[3]);
await sendTier("Other Maps", tiers.other);
  });


  reg.set("editmapcap", async (message, args) => {
  if (!isAdmin(message)) return;

  if (args.length < 4) {
    return message.channel.send(
      `Usage: !editmapcap <map|current> <#> <Blue|Red> <trigger> [points]`
    );
  }

  const mapArg = args.shift();
  const idx = Number(args.shift());
  let team = cleanQuotes(args.shift());

  if (!Number.isInteger(idx) || idx < 1) {
    return message.channel.send("Rule number must be a positive number. Use `!mapcaps <map>` to see rule numbers.");
  }

  if (!["Blue", "Red"].includes(team)) {
    return message.channel.send("Team must be `Blue` or `Red`.");
  }

  let points = 10;
  const maybePoints = Number(args[args.length - 1]);

  if (!isNaN(maybePoints)) {
    points = maybePoints;
    args.pop();
  }

  const trigger = cleanQuotes(args.join(" "));

  const map =
    mapArg.toLowerCase() === "current"
      ? getCurrentMap()
      : mapArg;

  if (!map) return message.channel.send("Could not determine current map.");
  if (!trigger) return message.channel.send("Missing trigger text.");

  const json = loadCaps();
  if (!json.maps) json.maps = {};

  if (!json.maps[map]?.length) {
    return message.channel.send(`No custom map caps found for **${map}**.`);
  }

  const realIdx = idx - 1;

  if (!json.maps[map][realIdx]) {
    return message.channel.send(`Rule #${idx} does not exist for **${map}**.`);
  }

  json.maps[map][realIdx] = {
    trigger,
    team,
    capValue: 1,
    scoreValue: points
  };

  saveCaps(json);

  return message.channel.send(
    `Edited map cap:\nMap: **${map}**\nRule: **#${idx}**\nTeam: **${team}**\nTrigger: \`${trigger}\`\nScore: **${points}**`
  );
});
  reg.set("addmapcap", async (message, args) => {
    if (!isAdmin(message)) return;

    if (args.length < 3) {
      return message.channel.send(
        `Usage: !addmapcap <map|current> <Blue|Red> <trigger> [points]`
      );
    }

    let [mapArg, team, ...rest] = args;
    team = cleanQuotes(team);

    if (!["Blue", "Red"].includes(team)) {
      return message.channel.send("Team must be `Blue` or `Red`.");
    }

    let points = 10;
    const maybePoints = Number(rest[rest.length - 1]);

    if (!isNaN(maybePoints)) {
      points = maybePoints;
      rest.pop();
    }

    const trigger = cleanQuotes(rest.join(" "));

    const map =
      mapArg.toLowerCase() === "current"
        ? getCurrentMap()
        : mapArg;

    if (!map) return message.channel.send("Could not determine current map.");
    if (!trigger) return message.channel.send("Missing trigger text.");

    const json = loadCaps();
    if (!json.maps) json.maps = {};
    if (!json.maps[map]) json.maps[map] = [];

    const exists = json.maps[map].some(x =>
      String(x.team).toLowerCase() === team.toLowerCase() &&
      String(x.trigger).toLowerCase() === trigger.toLowerCase()
    );

    if (exists) {
      return message.channel.send(`That cap rule already exists for **${map}**.`);
    }

    json.maps[map].push({
      trigger,
      team,
      capValue: 1,
      scoreValue: points
    });

    saveCaps(json);

    return message.channel.send(
      `Added map cap:\nMap: **${map}**\nTeam: **${team}**\nTrigger: \`${trigger}\`\nScore: **${points}**`
    );
  });

  reg.set("delmapcap", async (message, args) => {
    if (!isAdmin(message)) return;

    if (args.length < 2) {
      return message.channel.send(
        `Usage: !delmapcap <map|current> <trigger>`
      );
    }

    const map =
      args[0].toLowerCase() === "current"
        ? getCurrentMap()
        : args[0];

    const trigger = cleanQuotes(args.slice(1).join(" "));

    if (!map) return message.channel.send("Could not determine current map.");

    const json = loadCaps();

    if (!json.maps?.[map]?.length) {
      return message.channel.send(`No custom map caps found for **${map}**.`);
    }

  const before = json.maps[map].length;

  json.maps[map] =
    json.maps[map].filter(x =>
      String(x.trigger).toLowerCase() !== trigger.toLowerCase()
    );

    if (json.maps[map].length === before) {
      return message.channel.send(`No matching trigger found for **${map}**.`);
    }

    if (json.maps[map].length === 0) {
    delete json.maps[map];
  }

    saveCaps(json);

    return message.channel.send(
      `Removed trigger \`${trigger}\` from **${map}**.`
    );
  });

  reg.set("allmapcaps", async (message) => {
    if (!isAdmin(message)) return;

    const json = loadCaps();
    const maps = Object.keys(json.maps || {});

    if (!maps.length) {
      return message.channel.send("No custom map caps configured.");
    }

    const lines = [];

    for (const map of maps) {
      lines.push(`**${map}**`);

      for (const rule of json.maps[map]) {
        lines.push(
          `- ${rule.team} -> "${rule.trigger}" (${rule.scoreValue || 10})`
        );
      }
    }

    return message.channel.send(lines.join("\n").slice(0, 1900));
  });
}

module.exports = { register };