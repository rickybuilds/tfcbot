# No Name parsing

Final requirements: send the same collected logs to public TFCStats, public Hampalyzer, and a local copy of the Hampalyzer core. Public services provide result links. Local structured results populate our database directly, with no HTML scraping and no new frontend. The existing NoNamePugs website remains the frontend. Implement autonomously and validate with the two supplied siege logs; never commit those private logs.

## Architecture and consumers

`parser/` is a headless Node service using the pinned Hampalyzer core in `parser/upstream`, with its GPL-3.0-or-later license and provenance preserved. No upstream PostgreSQL server is needed. Private original logs and versioned JSON enable reprocessing beyond the game server's seven-day retention. The bot imports JSON into existing SQLite tables transactionally.

Pickup and casual paths send identical files to all three consumers and await their completion before cleanup. Public failures must not prevent local parsing. Keep downloaded files after any required consumer fails. A single log works locally even though public Hampalyzer's match endpoint requires two. Recaps retain public links. Remove automatic HTML importer invocation. Local parsing defaults to `http://127.0.0.1:3210`, protected by the shared `NONAME_PARSER_TOKEN`. Stats imports never modify official scores or ratings.

## Data contract and storage

Authenticated `POST /api/parseGame` or `/api/parseLog` accepts one or two multipart `logs[]`, `matchId`, optional `force=on`, and explicit `replace=on` for different saved inputs. Files are bounded at 8 MB each. Identical inputs are cached; duplicate round files are rejected. IDs allow 1–80 letters, digits, underscores and hyphens.

Response `{success:{path,api},result}` links to the existing match page and private API. Results include `schemaVersion`, `parserVersion`, `matchId`, `parsedAt`, `sourceHash`, `map`, `isValid`, `players`, `parsingErrors`, `hampalyzer`, `rounds`, and normalized `events`. `hampalyzer` retains every upstream structured summary, comparison and award, excluding raw event arrays/internal state. Gameplay events exclude raw log lines, chat, cvars and admin commands. Steam IDs use canonical `STEAM_` form.

`match_parser_results.result_json` retains the complete result, including stats not represented in existing website columns. Existing round, player, class, weapon, kill, cap, flag and MVP tables receive compatible projections; new tables are `match_sentry_round_stats` and `match_sentry_lives`. Reimports replace one match atomically, preserve independent TFCStats flag events and leave other match data intact. Source columns distinguish local imports from legacy rows.

## Sentry calculations

Track builds/upgrades/repairs/removals, observed lifetime, level segments, enemy player kills at levels 1/2/3/unknown, separate teamkills, longest life and confidence warnings. Uptime starts at build or first evidence and ends at removal or round end. Owner death alone does not remove a gun. Attribute teammate upgrades to the gun's owner. Missing build or level history remains incomplete or unknown. Engineer-relative uptime uses interval intersections and cannot exceed 100%. See `parser/SG-METRICS.md` for exact rules and projectile ambiguities.

## Operation and verification

Provide authenticated reads/writes, bounded uploads, private archives, health checks, CLI parse/import/reparse, Docker and PM2 packages, and retention/rollback documentation. Validate upstream fixtures, SG sequences, API/archive behavior, legacy SQLite compatibility, atomic/idempotent imports, failed-consumer cleanup, the bot suite, and supplied logs in a scratch database. No live database write or deployment claim without verified host access.
