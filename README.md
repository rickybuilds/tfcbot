# TFCBot

A custom Discord bot and server automation platform for Team Fortress Classic pickups and league play.

## Features
- Queue and matchmaking system
- Elo tracking and rankings
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

`off` is the only other supported mode. Live V2 rating writes are intentionally
not implemented yet; setting shadow mode can never mutate `ratings` or
`rating_changes`.

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

## Status
Actively developed.

---

Original development by Ricky.
