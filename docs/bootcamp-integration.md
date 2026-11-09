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
- `!learning` checks the authoritative Website license and reports whether the
  player has the Learner's permit required for learning pugs. It is disabled
  unless `BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED=true`. This is an eligibility
  check only; the Bot does not currently run a separate learning-pug queue.
- `!challenge` shows the active weekly route or drill challenge and its
  standings. It remains disabled until `BOOTCAMP_CHALLENGES_ENABLED=true`.
- `!season` shows active training season standings from the Website API. It
  remains disabled until `BOOTCAMP_SEASONS_ENABLED=true`.
- `!cosign @player` records a mentor's optional learning-pug attestation. It is
  disabled unless `BOOTCAMP_MENTOR_COSIGN_ENABLED=true` and
  `BOOTCAMP_MENTOR_ROLE_ID` are configured. The target needs a primary linked
  Steam ID; the website records the mentor Discord ID on the license.
- Record announcements link to the shared replay viewer using the Bootcamp
  replay API. Speedrun replay links and data stay separate.

## Role synchronization

The Bot reads event, challenge, player and license data through the
authenticated NoName website API. It does not query Bootcamp tables directly.
Configure the same high-entropy `BOOTCAMP_DISCORD_API_TOKEN` on the website and
Bot, and set `NONAME_URL` to the website's API origin on the Bot. The website
must have `BOOTCAMP_API_ENABLED=true` and the token configured before calls are
accepted. Do not put the token in source control or the delivery package.

Set `BOOTCAMP_WATCHER_ENABLED=true` to poll the authenticated event feed and
sync roles. Configure `BOOTCAMP_PERMIT_ROLE_ID`, `BOOTCAMP_LICENSED_ROLE_ID`,
`BOOTCAMP_PLATINUM_ROLE_ID`, optional `BOOTCAMP_OFFENSE_ROLE_ID`, and optional
`BOOTCAMP_<CLASS>_ROLE_ID` values. The existing `OFFENSE_ROLE_ID` remains
separate from the Bootcamp offense-endorsed role.

The watcher also assigns `BOOTCAMP_QUEUE_REQUIRED_ROLE_ID` to licensed and
platinum members. If it is unset, the configured licensed role is reused.
`BOOTCAMP_OFFENSE_ROLE_ID` is assigned only to members with the offense
endorsement; existing manually granted `OFFENSE_ROLE_ID` is not removed by
Bootcamp synchronization.

The Bot initializes its cursor from the website event cursor endpoint so old
events are not replayed on first startup. It persists the cursor after each
successful notification; failed Discord sends, API requests, account-link
lookups or role synchronization leave the event eligible for retry. Tier
changes request an authoritative license recomputation through the website API;
license display and role sync then read the player's current profile. Configure
an available Bootcamp channel (or a channel with the configured name) before
enabling the watcher; publishable events remain queued while no channel is
available.

Weekly challenge posts are separately controlled by
`BOOTCAMP_CHALLENGE_ANNOUNCEMENTS_ENABLED=true` and require the watcher to be
enabled. Challenge details and standings come from the website API. The
watcher stores the last successfully announced challenge ID and retries a
failed delivery. See `TFC-Bootcamp/docs/weekly-challenges.md` for the
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

The optional `!learning` command is separately gated by
`BOOTCAMP_LEARNING_ELIGIBILITY_ENABLED=false` by default.

Enable role synchronization and verify linked accounts, role assignment,
Discord `!add`, HLDS `!add`, admin bypass, and offense selection in a test guild
before configuring either enforcement flag on a production bot. No production
service was changed as part of this integration.
