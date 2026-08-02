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
roster, and posts current-versus-shadow deltas to `RECAP_CHANNEL_ID`.

The default even-match transfer pool is 40 points (`ELO_V2_TEAM_K=80`). Player
shares are bounded to 15%-35%. Matches with extra/missing performance rows,
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

## Status
Actively developed.

---

Original development by Ricky.
