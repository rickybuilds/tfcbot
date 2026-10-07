# No Name Parser

Raw HLDS logs go to three destinations: TFCStats and Hampalyzer.com for their public results/links, and the local Hampalyzer parsing core for complete JSON imported into tfcbot's SQLite database. The existing NoNamePugs website remains the frontend. No website scraping supplies our database.

The service runs on the bot host, normally at `127.0.0.1:3210`. tfcbot sends the collected round logs to all three consumers concurrently, imports the local result in one database transaction, and completes its recap with the public links. Uploads have deadlines; failures retain downloaded logs for retry. A failed public upload does not stop local parsing. Existing Elo/report authority stays with tfcbot.

## Install and run on the bot host

Use Node 22 or newer; use Node 22 for this repository's existing native database dependencies.

```sh
cd /root/tfcbot/parser
npm ci
npm run build
cp .env.example .env
```

Set a long random `NONAME_PARSER_TOKEN` in `parser/.env` and the bot's environment. Create `/var/lib/noname-parser` owned by the service user, or choose another private persistent `NONAME_PARSER_DATA_DIR`. Do not put this directory under the website's document root. Node's `--env-file` loads the service environment:

```sh
node --env-file=.env dist/src/server.js
```

For PM2:

```sh
pm2 start deploy/ecosystem.config.cjs
pm2 save
curl --fail http://127.0.0.1:3210/health
```

The bot defaults to `http://127.0.0.1:3210`. Set `NONAME_PARSER_URL` if needed, `NONAME_PARSER_TOKEN` to the same value, and `DB_PATH` if its stats database is outside `/root/tfcbot/elo.db`. Restart tfcbot with the updated environment after the parser health check succeeds. The parser is headless and private; no nginx/public port is required.

## Database contents

`match_parser_results.result_json` retains the entire versioned result, including `hampalyzer`: all upstream round summaries, player/team stats, class times, weapon breakdowns, flag movement summaries, comparisons and awards. Raw event arrays/internal objects are excluded from that summary; normalized gameplay events are separately included in `events`. Credentials, cvars, admin commands and chat are not included. The original logs are kept privately for future recalculation.

The importer also populates the website's existing tables: `match_stat_imports`, `match_rounds`, `match_player_stats`, `match_player_round_stats`, `match_player_classes`, `match_player_weapons`, `match_kill_events`, `match_cap_events`, `match_flag_events` and `match_round_mvps`. It adds missing columns transactionally without modifying official match scores or ratings. New SG projections are `match_sentry_round_stats` and `match_sentry_lives`. Those tables are ready for the existing website to expose; this change does not add SG controls to that website.

Reimporting a match replaces that match's projections and complete result atomically, without duplicating events or deleting independent TFCStats flag rows. Older matches retain their data and legacy provenance. Old SG history cannot be reconstructed when its source logs no longer exist.

SG rows are keyed by match, player, round and `observed_team` (the logged numeric team color), so a player changing teams within a round retains both histories. Life numbers restart for each observed team. `team_name` remains the original match roster's Team A/B identity.

## SG details

The tracker records builds, upgrades (including teammate upgrades), repairs, destruction/dismantling/detonation, observed uptime, time at each level, enemy player kills at levels 1/2/3 or unknown, separate teamkills, longest life and each gun's level segments. Owner death alone does not remove a sentry. Missing history is labeled incomplete, and engineer uptime uses time intersections so it cannot exceed 100%. See [SG-METRICS.md](SG-METRICS.md) for exact definitions and projectile limitations.

## Retention and reprocessing

Every successfully parsed match archives one or two original logs plus its structured result in `NONAME_PARSER_DATA_DIR/<matchId>/`. These archives outlive the game server's seven-day log cleanup. There is no automatic archive purge. Back up this directory with the database and monitor its disk usage.

Parse local files without starting the HTTP service:

```sh
npm run parse -- --match-id MATCHID --data-dir /var/lib/noname-parser --output result.json ROUND1.log ROUND2.log
```

To parse **and immediately import into the database**, run from the tfcbot repository:

```sh
node tools/parseNoNameLogs.js --match-id MATCHID --db /root/tfcbot/elo.db ROUND1.log ROUND2.log
```

Reparse a retained match with a newer parser and reimport:

```sh
NONAME_PARSER_DATA_DIR=/var/lib/noname-parser node tools/parseNoNameLogs.js --match-id MATCHID --db /root/tfcbot/elo.db --reparse
```

## Private HTTP API

`POST /api/parseGame` (or `/api/parseLog`) accepts multipart `logs[]`, one or two plain `.log` files up to 8 MB each, `matchId`, optional `force=on` (skip upstream match validation), and optional `replace=on` (intentionally replace different saved logs). Supply `Authorization: Bearer <token>`. Identical inputs return the cached result; duplicate round files are rejected.

Success is `{success:{path,api},result}`. `path` points to the existing website's `match.html?id=...`; `api` is the private structured result. `GET /api/matches/:id` and `GET /api/matches` require the same token. `/health` checks storage and needs no token. IDs allow 1–80 letters, numbers, underscores and hyphens.

## Verification and rollout

```sh
npm test
npm run build
```

Tests include the pinned upstream fixtures, hand-calculated SG sequences and real HTTP/archive behavior. The supplied October 7 siege logs were also parsed and imported into a scratch database, never the live database. Private user logs are not committed.

Before switching a host, back up `elo.db` using SQLite's backup API and keep the current deployment revision. Run one known match through the command-line importer and confirm `match_stat_imports.source='noname'`, a full `match_parser_results` row, and SG summary/lifetime rows. Then start the parser and restart tfcbot. Roll back code to the previous deployment revision if necessary; restoring the database backup is only needed if deliberately reverting imported data. Keep archived logs so imports can be retried.

## Docker alternative

```sh
docker build -t noname-parser ./parser
docker run -d --name noname-parser --restart unless-stopped \
  -p 127.0.0.1:3210:3210 --env-file ./parser/.env \
  -e NONAME_PARSER_HOST=0.0.0.0 -e NONAME_PARSER_DATA_DIR=/data \
  -v noname-parser-data:/data noname-parser
```

The database import still happens in tfcbot on the host. Keep the container port bound to loopback.
