# TFCBot

A custom Discord bot and server automation platform for Team Fortress Classic pickups and league play.

## Features
- Queue and matchmaking system
- Elo tracking and rankings

## Captain drafts

Players can volunteer as captains while joining a pickup with `!addcap`, `++cap`,
or `**cap`. When exactly two queued players are marked, the full match uses a
captain draft after the server/map votes. Team 1 is the first captain who joins
with a captain command; Team 2 is the second. The captains select the remaining
players with Discord buttons. Before the draft, the captains play blind Rock
Paper Scissors; ties repeat and the winner picks first. The resulting rosters
are the teams used for the match and its ELO result. With fewer than two
captains, the normal ELO balance remains active.
- Match reporting and history
- Admin and moderation tools
- RCON server integration
- Voice relay / spectator support

## Elo V2 shadow mode

Set `ELO_V2_MODE=shadow` to calculate and persist proposed Elo V2 results
without changing live ratings. After a match report, the worker waits for the
No Name `nn-mvp-v1` player scores, validates them against the official 4v4
roster, and posts current-versus-shadow deltas to `ELOTEST_CHANNEL_ID`. If that
setting is absent, the worker falls back to `RECAP_CHANNEL_ID`.

The shadow keeps the exact Blue and Red team totals already produced by V1 and
only redistributes each total by individual performance. This preserves current
volatility, odds behavior, mode bonuses, caps, and existing inflation/deflation
while isolating the allocation change for evaluation. Each Discord result shows
two side-by-side scenarios: a wide 15%-35% share range with performance strength
0.35, and a gentle 20%-30% range with performance strength 0.20. Both scenarios
preserve the same V1 team totals. Matches with extra/missing performance rows,
ambiguous identity mappings, or unavailable stats use an equal 25% split and
record the fallback reason. Snapshots are stored in `elo_shadow_results`.

`off` disables V2. `live-gentle` is the controlled live mode: it prepares the
V1 team pools without writing them, waits for validated `nn-mvp-v1` scores, and
then writes the 20%-30% Gentle allocation. If performance data cannot be
validated before the retry limit, it safely applies the equal 25% split. A
rating guard refuses to apply a delayed result if another rating change has
already moved a player's rating.

## Tech Stack
- Node.js
- discord.js
- SQLite
- HLDS / RCON

## Automatic pickup clip attachments

Set these variables in the bot's runtime environment to post the rendered replay
clip as a Discord `.webm` attachment in addition to the replay link:

```env
PICKUP_REPLAY_AUTO_CLIPS=1
PICKUP_REPLAY_ATTACH_WEBM=1
# 100 for a Level 3 server; use 250 if the server has the larger-upload tier.
PICKUP_REPLAY_MAX_ATTACHMENT_MB=100
PICKUP_CLIPS_CHANNEL_ID=your_discord_channel_id
PICKUP_REPLAY_BROWSER_PATH=/usr/bin/chromium
```

The bot uses headless Chromium to render the same replay-v2 page and download
the selected clip. Install Chromium on the bot host, restart the bot after
changing the environment, and check for `posted ... clean pickup clip(s)` in
the bot log. If the renderer is unavailable, the bot preserves the existing
link-only post and logs the render error.

### Offline replay QA

Inspect a completed match without starting a recorder or posting to Discord:

```bash
node scripts/testPickupReplay.js YZV8LE
node scripts/testPickupReplay.js YZV8LE 1 --base-url https://nonamepickup.servehalflife.com/pickup-replay.html
```

The command reports the first confirmed scoring carry, its carrier session,
clip bounds, and the replay URL. This is the safe path for validating player
selection and clip timing before enabling automatic live posts.

## Status
Actively developed.

---

Original development by Ricky.
