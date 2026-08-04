# 1v1 subsystem

This directory contains the isolated 1v1 implementation. It is inert by default.

## Safety flags

- `ONEVONE_ENABLED=0` disables the subsystem.
- `ONEVONE_DRY_RUN=1` prevents live match actions while command work is developed.
- `ONEVONE_SERVER_SETUP_ENABLED=0` prevents RCON setup and restoration.
- `ONEVONE_POST_MAP_DELAY_SECONDS=10` controls the settle period after `ass_dm`
  loads and before the plugin cvars are applied with `amx_cvar`.

All three flags must be deliberately reviewed before live server setup is added.

## Database migration

Inspection only:

```text
npm run 1v1:migrate:check
```

Applying the migration is intentionally not an npm script. On the production
host, first stop match activity and verify the database backup location, then run:

```text
./backup.sh
gzip -t backups/elo_YYYYMMDD_HHMMSS.db.gz
node scripts/migrate-one-v-one.js --apply --skip-backup
```

The apply command refuses to run unless `--skip-backup` explicitly acknowledges
that a fresh SQLite-safe external/compressed backup was already created and verified.
This avoids an unsafe raw copy and an extra 1.8GB temporary file on production.

## Current build boundary

Implemented:

- configuration and safety flags;
- atomic in-memory server reservations compatible with `lockedServers`;
- idempotent schema migration;
- structured `1V1_MATCH_END` parsing;
- Discord `!1v1 @opponent`, admin `!1v1 @player1 @player2`, `!accept`, and `!decline` commands behind the feature flag;
- an isolated two-player server vote with both votes counted and randomized tie resolution;
- pending-challenge persistence and restart restoration when the migration is present;
- reservation and SteamID verification for machine-readable match-end events;
- per-source HLDS log filename tracking for simultaneous servers;
- active reservation recovery after restart;
- duplicate match-end suppression and retained reservations on processing failure;
- restore-before-release with quarantine on restoration failure;
- active admin cancellation after successful restoration;
- two-stage map handshake that configures assigned players only after `Started map`;
- join, ready, setup, and disconnect-grace timers;
- restoration to the established default map `pushNN`;
- reuse of log transfer, Hampalyzer/TFCStats links, one Discord result recap, and silent stats import;
- pickup server filtering through the shared reservation service;
- unit tests for those foundations.

Not enabled yet:

- RCON commands;
- AMXX or server configuration changes.
