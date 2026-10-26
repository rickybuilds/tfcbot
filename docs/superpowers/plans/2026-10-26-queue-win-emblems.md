# Queue win emblems implementation plan

**Goal:** Prefix queue player names with the uploaded TFC class emojis.

**Design:** Use completed match winners and team membership for all-time wins. Milestones: Civilian 0, Scout 25, Pyro 50, Medic 75, Spy 100, Sniper 150, Engineer 375, Soldier 750, Demoman 1125, Heavy 1500. Emoji precedes the existing captain/name/supporter/ADL text, including full-time offense. Use the supplied emoji IDs, which survive renaming. No database writes or dependencies.

**Architecture:** A focused `lib/winEmblems.js` maps milestones and reads wins in one batch per board. `commands/queue.js` passes the resulting prefixes into both roster renderers. Missing win storage leaves names usable without an unverified badge.

**Tech stack:** CommonJS, discord.js, better-sqlite3, node:test.

## Task 1
- [x] Add boundary tests, real in-memory database win counting tests, and embed prefix tests in `test/winEmblems.test.js`; run and observe failure (missing helper).
- [x] Implement `winEmblem(wins)` and `queueWinEmblems(elo, ids)` and wire into queue rendering.
- [x] Verify completed wins, losing teams, draws, pending games, duplicate roster entries, deletions, missing storage, and captain/ADL/offense rendering.
- [x] Run focused queue tests and attempt full bot suite; review diff.

Verification: focused queue/emblem tests pass. Full suite reported failures in log import, SKILLS replay state, and Rule 8, then remained running without a final summary and was interrupted. No full-suite success claimed. Updated removeadl to pass its existing Elo dependency when refreshing the board. No deployment or restart performed.
