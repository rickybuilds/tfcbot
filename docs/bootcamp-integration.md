# Bootcamp Discord integration

The Bootcamp watcher and both queue gates are disabled unless their explicit
environment flags are enabled. No production role or queue behavior changes
when these values are unset.

## Commands

- `!bootcamp` links to the feature-flagged NoName training hub and gives the
  in-game `/tt_lessons` entry point.
- `!license` shows the player's linked Steam IDs, authoritative license,
  endorsements and profile link. If no Steam ID is linked, it directs the
  player to an administrator-managed `!linksteam` link.
- `!challenge` shows the active weekly route or drill challenge and its
  standings. It remains disabled until `BOOTCAMP_CHALLENGES_ENABLED=true`.
- Record announcements link to the shared replay viewer using the Bootcamp
  replay API. Speedrun replay links and data stay separate.

## Role synchronization

Set `BOOTCAMP_WATCHER_ENABLED=true` to start polling `bootcamp_events` and sync
roles. Configure `BOOTCAMP_PERMIT_ROLE_ID`, `BOOTCAMP_LICENSED_ROLE_ID`,
`BOOTCAMP_PLATINUM_ROLE_ID`, optional `BOOTCAMP_OFFENSE_ROLE_ID`, and optional
`BOOTCAMP_<CLASS>_ROLE_ID` values. The existing `OFFENSE_ROLE_ID` remains
separate from the Bootcamp offense-endorsed role.

The watcher also assigns `BOOTCAMP_QUEUE_REQUIRED_ROLE_ID` to licensed and
platinum members. If it is unset, the configured licensed role is reused.
`BOOTCAMP_OFFENSE_ROLE_ID` is assigned only to members with the offense
endorsement; existing manually granted `OFFENSE_ROLE_ID` is not removed by
Bootcamp synchronization.

The event cursor is persisted after each successful notification, and failed
Discord sends or role synchronization leave the event eligible for retry. The
watcher also announces lesson completions and reads license details from the
authoritative `bootcamp_licenses` row when delivering a license event. Configure
an available Bootcamp channel (or a channel with the configured name) before
enabling the watcher; publishable events remain queued while no channel is
available.

Weekly challenge posts are separately controlled by
`BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED=true` and require the watcher to be
enabled. The watcher stores the last successfully announced challenge ID and
retries a failed delivery. See `TFC-Bootcamp/docs/weekly-challenges.md` for the
shared challenge schema and scheduling tool.

## Optional queue enforcement

Both switches default to false:

```dotenv
BOOTCAMP_QUEUE_GATE_ENABLED=false
BOOTCAMP_OFFENSE_GATE_ENABLED=false
```

`BOOTCAMP_QUEUE_GATE_ENABLED=true` gates Discord `!add` commands and in-game
HLDS `!add` queue events on the queue-required role. Administrators retain
access. `BOOTCAMP_OFFENSE_GATE_ENABLED=true` requires the Bootcamp offense
endorsement for full-time offense selection. Existing queue role rules remain
unchanged when these flags are false.

Enable role synchronization and verify linked accounts, role assignment,
Discord `!add`, HLDS `!add`, admin bypass, and offense selection in a test guild
before configuring either enforcement flag on a production bot. No production
service was changed as part of this integration.
