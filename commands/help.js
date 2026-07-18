// commands/help.js
"use strict";

const { EmbedBuilder } = require("discord.js");
const { isAdmin } = require("../lib/guards");

function register(reg, { config }) {
  reg.set("help", async (message) => {
    const admin = isAdmin(message);

    // Clean pickup channel
    if (message.channel?.id === config.channels.pickup) {
      try { await message.delete().catch(() => {}); } catch {}
    }

    const emb = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("NoNamePickups — Command List")
      .setDescription("Here are the available commands:")
      .setTimestamp();

    // Player Commands
    emb.addFields({
      name: "🎮 Player Commands",
      value:
        "`!add` / `++` — Join the regular pickup queue\n" +
        "`!addadl` / `++adl` / `**` — Join the ADL (Attack & Defend) queue\n" +
        "`!remove` / `--` — Leave the current queue\n" +
        "`!status` — Show current queue status\n" +
        "`!notice` — Ping @TFCPlayer role when queue ≥ 5\n" +
        "`!admin` — Ping admin role for assistance\n" +
        "`!timeleft` — Show current map and time left on the active server\n" +  // ✅ added here
        "`!maplist` — Shows current maplist\n" +
        "`!ranks` — Display Elo rank bands\n" +
        "`!elo` — DM you your current Elo stats\n" +
        "`!elowith <name>` — Shared Elo stats with a player\n" +
        "`!eloagainst <name>` — Head-to-head Elo comparison\n" +
        "`!permapelo` — Per-map Elo & W/L/T stats (DM)\n" +
        "`!elocsv` — Export your Elo history as CSV\n" +
        "`!tfcmap <mapname>` — Check if a map exists on mrclan/tfcmaps.net",
    });


    // ---------------- Admin Commands ----------------
    if (admin) {
      emb.addFields(
        {
          name: "⚙️ Queue & Match Control",
          value:
            "`!clear` — Reset queue + cancel votes\n" +
            "`!addplayer @user` / `!removeplayer @user` — Manage queue manually\n" +
            "`!kick @user` — Kick player from queue\n" +
            "`!fv` — Start map/server vote\n" +
            "`!cancelvote` — Cancel active vote\n" +
            "`!requeue` — Reset and rebuild queue\n" +
            "`!report <id> (blue|red|tie)` — Report match result\n" +
            "`!fixreport <id> (blue|red|tie)` — Correct match result\n" +
            "`!delmatch <id>` — Delete match and revert Elo\n" +
            "`!shuffle <matchId> [#]` — Apply the next or a numbered Elo scenario\n" +
            "`!setmap <matchId> <map>` — Manually correct the map name\n" +
            "`!unlock <matchId>` — Force-unlock a stuck server",
        },
        {
          name: "📈 Elo Management",
          value:
            "`!searchelo <name>` — Search player Elo\n" +
            "`!bumpelo @user <delta>` — Adjust Elo (e.g. -15 or +10)\n" +
            "`!allelo` — List all users’ Elo ratings\n" +
            "`!deluser <discordId>` — Remove user from Elo DB\n",
        },
        {
          name: "🚫 Moderation & Jail",
          value:
            "`!ban @user <games> [reason]` — Temporary ban (x games)\n" +
            "`!permaban @user` — Permanent ban (adds permaban role)\n" +
            "`!unban @user` — Remove active ban / restore permissions\n" +
            "`!unjail @user` — Restore roles to a jailed player\n" +
            "`!listbans` — Show active game bans",
        },
        {
          name: "🗺️ Map Management",
          value:
            "`!addmap <map> <mirvs> <tier>` — Add map to CTF pool\n" +
            "`!mapedit <#> <map> <mirvs> <tier>` — Edit map entry\n" +
            "`!mapdel <#>` / `!mapremove <#>` — Delete map\n" +
            "`!maplist` — List all CTF maps\n" +
            "`!adladdmap <map> <mirvs>` — Add map to ADL pool\n" +
            "`!adlmapedit <#> <map> <mirvs>` — Edit ADL map entry\n" +
            "`!adlmapdel <#>` / `!adlmapremove <#>` — Delete ADL map\n" +
            "`!adlmaplist` — List all ADL maps",
        },
        {
          name: "🖥️ Server & RCON",
          value:
            "`!rcon <server> <command>` — Run RCON command (admin-only)\n" +
            "`!timeleft [server]` — Show live match map/timeleft info",
        }
      );
    }

    // ---------------- DM Send ----------------
    try {
      await message.author.send({ embeds: [emb] });
    } catch {
      // ignore if DMs closed
    }
  });
}

module.exports = { register };
