# `elo.db` schema

`elo.db` is the bot's runtime SQLite database. It is created locally when the
bot starts and must not be committed to the repository. The repository ignores
the database and SQLite's WAL sidecar files (`*.db`, `*.db-wal`, and
`*.db-shm`).

The default path is `elo.db` in the process working directory. The bot accepts
`DB_PATH` or `ELO_DB` for the main database path. The parser also uses
`DB_PATH` when importing match statistics.

## Important conventions

- IDs are stored as `TEXT` and should be treated as strings, even when they
  contain Discord or Steam numeric IDs.
- Unix timestamps are stored as integer seconds unless a column is explicitly
  documented otherwise.
- Player IDs in the Elo tables are Discord user IDs.
- `match_id` is the stable identifier shared by match records, Elo changes,
  shadow results, and imported statistics.
- Team/player lists such as `blue_ids`, `red_ids`, and `offense_ids` are JSON
  text arrays, not comma-separated strings.
- SQLite migrations are intentionally additive. A fork should start with an
  empty database and let the bot create/migrate it; do not copy a production
  database into source control.

The SQL in the owning module is the source of truth. This file is the human
readable contract for fork maintainers and may need updating when a migration
adds a column.

## Core Elo tables

### `ratings`

One current row per player.

| Column | Type | Meaning |
| --- | --- | --- |
| `player_id` | `TEXT PRIMARY KEY` | Discord user ID |
| `display_name` | `TEXT` | Last useful display name known to the bot |
| `rating` | `INTEGER NOT NULL` | Current Elo rating |

The rating is seeded from `ELO_START` (default `1941`) when a player is first
seen. Ratings are clamped by the Elo implementation; do not infer historical
ratings from this table.

### `rating_changes`

Append-only-ish audit history for rating mutations. Normal match changes,
admin changes, seed rows, and decay rows are all represented here.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Row ID |
| `match_id` | `TEXT NOT NULL` | Match/action ID; may use prefixes such as `admin-`, `seed-`, or `decay` |
| `ts` | `INTEGER` | Unix timestamp in seconds |
| `player_id` | `TEXT NOT NULL` | Discord user ID |
| `before` | `INTEGER NOT NULL` | Rating before this mutation |
| `after` | `INTEGER NOT NULL` | Rating after this mutation |
| `delta` | `INTEGER NOT NULL` | `after - before` |

Some older installations may have `created_at` as a legacy compatibility
column because older match imports wrote it. New Elo writes use `ts`.

### `rule8_infractions`

Current Rule 8 state, keyed by Discord user.

| Column | Type | Meaning |
| --- | --- | --- |
| `discord_id` | `TEXT PRIMARY KEY` | Discord user ID |
| `count` | `INTEGER NOT NULL` | Current infraction count |
| `last_infraction_at` | `INTEGER NOT NULL` | Unix timestamp in seconds |
| `last_issued_by` | `TEXT NOT NULL` | Discord user ID or actor identifier |

### `rule8_infraction_events`

Historical Rule 8 events. Unlike `rule8_infractions`, this table keeps one row
per issued event.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Event ID |
| `discord_id` | `TEXT NOT NULL` | Penalized Discord user ID |
| `issued_by` | `TEXT NOT NULL` | Issuing actor |
| `created_at` | `INTEGER NOT NULL` | Unix timestamp in seconds |
| `match_id` | `TEXT` | Related match, when applicable |

## Match and player identity tables

The bot expects a `matches` base table and its `match_results` read view from
the match-store schema used by this deployment. The match store writes these
fields:

| Column | Type/shape | Meaning |
| --- | --- | --- |
| `match_id` | text, unique | Match identifier |
| `created_at` | Unix seconds | Match creation time |
| `map_name` | text | Map played |
| `server_name` | text | Server used |
| `blue_ids` | JSON text array | Blue roster, by Discord ID |
| `red_ids` | JSON text array | Red roster, by Discord ID |
| `offense_ids` | JSON text array, optional | Full-time offense roster; excluded from Elo |
| `winner` | `blue`, `red`, or `tie` | Match result |
| `processed_at` | Unix seconds, nullable | Result/Elo processing time |
| `status` | text | Match lifecycle state |
| `mode` | text, optional | Match mode, such as ADL |
| `rng_multiplier` | numeric, optional | Match multiplier input |
| `bonus_elo` | JSON text, optional | Stored bonus allocation/details |
| `team_scenarios` | JSON text, optional | Balance/draft scenario history |
| `match_type` | text, default `pickup` | `pickup` or another match type |
| `player_format` | text, default `4v4` | Format label |
| `expected_players` | integer, default `8` | Expected roster size |
| `scoring_mode` | text, default `rounds` | Match scoring mode |

`match_results` is a read projection over match data. Code should write to the
base `matches` table and use the view for result reads where the match store
does so.

Player identity-related tables may be present when identity tracking is
enabled:

- `player_identities`: current Steam identity, linked Discord ID, name/IP/
  server, first/last seen, connection count, and connect/disconnect timestamps.
- `steam_alias_history`: aliases observed for a Steam ID, with first/last seen
  timestamps and a count.
- `player_steam_ids`: Discord-to-Steam link records used when syncing identity
  data.
- `user_prefs`: `player_id` and `hide_elo` (`0`/`1`) for Elo privacy settings.

## Feature and import tables

These tables are additive extensions created by the feature that needs them.
They should not be treated as prerequisites for a minimal Elo-only fork.

- `elo_shadow_results`: V2/shadow calculation snapshots, statuses, retry
  metadata, allocation JSON, and optional live-application state.
- `one_v_one_challenges`: challenge lifecycle and challenger/challenged Discord
  IDs.
- `one_v_one_matches`: 1v1 players, server/result data, scores, timing, and
  status; links to `matches` by `match_id`.
- `match_rounds`, `match_player_round_stats`, `match_round_mvps`,
  `match_kill_events`, `match_cap_events`, and `match_flag_events`: imported
  Hampalyzer/TFCStats round and event data.
- `match_stat_imports`, `match_player_stats`, `match_player_classes`, and
  `match_player_weapons`: imported match-summary/stat projections created by
  the No Name/Hampalyzer import path.
- `pickup_replay_recordings`, `pickup_replay_auto_clips`, and
  `pickup_replay_live_clips`: replay recording and clip state.
- `speedrun_wr_announcements` and `speedrun_wr_announcements_v2`: speedrun
  watcher announcement state.

Some optional features create their tables lazily. A fresh fork may therefore
have fewer tables than a production database until those features are enabled.

## Migrations and backups

Startup migrations use `CREATE TABLE IF NOT EXISTS` and targeted `ALTER TABLE`
checks. Do not manually delete or rename columns in a live database unless you
also update the owning code and migration path.

Back up the database as a SQLite database, including committed WAL contents.
The bot's SQLite-aware backup path includes `elo.db`; copying only the main
file while it is running can omit recent WAL data. Restore the database before
starting the bot and let startup migrations complete.

For a quick inspection of a local runtime database:

```sh
sqlite3 elo.db '.tables'
sqlite3 elo.db 'PRAGMA table_info(ratings);'
sqlite3 elo.db 'PRAGMA table_info(rating_changes);'
```

The production `elo.db` remains local state. Forks should commit this document
and the migration-owning source files, never the database itself.
