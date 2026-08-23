"use strict";

// Offline replay QA: inspect an already-recorded match without posting to
// Discord, touching a live server, or changing recorder state.
const fs = require("node:fs");
const path = require("node:path");
const {
  buildClipUrl,
  findCleanFirstPickupCap,
  parseEventsCsv,
} = require("../services/pickupReplayClips");

function usage() {
  console.error(
    "Usage: node scripts/testPickupReplay.js MATCH_ID [ROUND ...] [--events-dir DIR] [--base-url URL]"
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--events-dir") options.eventsDir = argv[++index];
    else if (value === "--base-url") options.baseUrl = argv[++index];
    else positional.push(value);
  }
  return { positional, options };
}

async function loadEvents(matchId, round, options) {
  if (options.eventsDir) {
    const file = path.join(options.eventsDir, `${matchId}-round-${round}-events.csv`);
    return fs.readFileSync(file, "utf8");
  }
  const response = await fetch(
    `https://nonamepickup.servehalflife.com/api/pickup-replays/viewer/${encodeURIComponent(matchId)}/${round}/files/events.csv`
  );
  if (!response.ok) throw new Error(`events.csv request failed (${response.status})`);
  return response.text();
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [matchId, ...roundArgs] = positional;
  if (!matchId) return usage();
  const rounds = roundArgs.length ? roundArgs.map(Number) : [1, 2];
  if (rounds.some(round => !Number.isInteger(round) || round < 1)) return usage();

  const output = [];
  for (const round of rounds) {
    const csv = await loadEvents(matchId, round, options);
    const clip = findCleanFirstPickupCap(parseEventsCsv(csv));
    output.push({
      matchId,
      round,
      clip,
      url: clip
        ? buildClipUrl(matchId, round, clip, options.baseUrl)
        : null,
    });
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(`[testPickupReplay] ${error.message}`);
  process.exitCode = 1;
});
