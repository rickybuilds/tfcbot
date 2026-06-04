// scripts/hampalyzer_fun_stuff_scrape.js
"use strict";

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fetch = require("node-fetch"); // npm i node-fetch@2
const db = new sqlite3.Database(path.join(__dirname, "../elo.db"));

const BASE_URL = "http://app.hampalyzer.com";
const MAX_PAGES = 350; // how many pages of logs to check
const DELAY_MS = 800;  // politeness delay between log requests

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[ERROR fetchJson] ${url}: ${err.message}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Parse players from Hampalyzer parsedlog page (HTML)
// -----------------------------------------------------------------------------
async function fetchPlayerData(parsedlog) {
  const url = `${BASE_URL}/parsedlogs/${parsedlog}/`;
  console.log(`🔗 Fetching player data from ${url}`);
  try {
    const html = await fetch(url).then((r) => r.text());
    const players = [];

    // Regex pattern for SteamID64 and player name (data-steamid="...">Name)
    const regex = /data-steamid="(\d+)"[^>]*>([^<]+)</g;
    let match;
    while ((match = regex.exec(html))) {
      const steamId = match[1];
      const name = match[2].trim();
      players.push({ steamId, name });
    }

    console.log(`   👤 Found ${players.length} players in ${parsedlog}`);
    return players;
  } catch (err) {
    console.error(`[ERROR fetchPlayerData] ${url}: ${err.message}`);
    return [];
  }
}

// -----------------------------------------------------------------------------
// MAIN SCRAPER
// -----------------------------------------------------------------------------
async function main() {
  console.log("🔍 Starting Hampalyzer scrape for server: 'fun stuff'...");

  // Ensure supporting table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS player_names (
      steam_id TEXT PRIMARY KEY,
      name TEXT
    );
  `);

  const seen = new Set();
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFetched = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE_URL}/api/logs/${page}`;
    const list = await fetchJson(url);
    if (!Array.isArray(list) || !list.length) break;

    console.log(`📄 Page ${page} → ${list.length} matches`);

    // Only include logs where "server" contains "fun stuff"
    const filtered = list.filter(
      (m) =>
        typeof m.server === "string" &&
        m.server.toLowerCase().includes("fun stuff") &&
        m.is_valid
    );

    if (!filtered.length) {
      console.log(`   ⏩ No fun-stuff matches on this page`);
      continue;
    }

    for (const match of filtered) {
      const parsedlog = match.parsedlog;
      console.log(`   🎯 Scraping ${parsedlog} (${match.server})`);
      const players = await fetchPlayerData(parsedlog);
      totalFetched += players.length;

      for (const p of players) {
        if (seen.has(p.steamId)) continue;
        seen.add(p.steamId);

        // insert into player_links
        await new Promise((res) => {
          db.run(
            "INSERT OR IGNORE INTO player_links (discord_id, steam_id, verified) VALUES (NULL, ?, 0)",
            [p.steamId],
            (err) => {
              if (err) console.error("[DB player_links]", err.message);
              res();
            }
          );
        });

        // insert/update name
        await new Promise((res) => {
          db.run(
            "INSERT OR REPLACE INTO player_names (steam_id, name) VALUES (?, ?)",
            [p.steamId, p.name],
            (err) => {
              if (err) console.error("[DB player_names]", err.message);
              else totalInserted++;
              res();
            }
          );
        });
      }

      await sleep(DELAY_MS);
    }

    const skipped = list.length - filtered.length;
    totalSkipped += skipped;
    if (skipped) console.log(`   ⏩ Skipped ${skipped} non-fun-stuff logs`);
    await sleep(1500); // polite pause between pages
  }

  console.log(
    `✅ Done! Inserted/updated ${totalInserted} names, total fetched players: ${totalFetched}, skipped ${totalSkipped} non-matching logs.`
  );
  db.close();
}

// -----------------------------------------------------------------------------
// ENTRYPOINT
// -----------------------------------------------------------------------------
main()
  .then(() => console.log("✅ Scraper finished successfully"))
  .catch((err) => {
    console.error("❌ Fatal:", err);
    db.close();
  });
