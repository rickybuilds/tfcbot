# Private match predictions

Predictions use points completely separate from ELO. The feature is disabled by default. This branch does not authorize deployment or changes to production data.

## Player rules

- Every Discord account receives 1,000 points once, on its first private balance interaction or player reward.
- Use Blue / Team 1, Red / Team 2, or Tie on the match card. One active pick, with a whole-number stake starting at a maximum of 100 points per game. Your personal maximum increases by 10 for each distinct settled game you bet on, with no fixed upper cap: `100 + 10 × settled games bet on`. You must still have enough available points. Editing replaces the previous stake. Funds are reserved immediately.
- Wins, losses, ties and settled no-correct-bettor refunds count equally toward progression. Opening a modal, editing, cancelling, pregame refunds and voided games do not count; duplicate reports and corrections do not count again. Player rewards alone do not increase a player's limit. The higher limit does not itself grant points. Earned progression is retained when an already-settled result goes to owner review.
- My Bet privately shows the pick, stake, available balance, game state, current maximum and settled-game count. Change or cancel before closure; cancellation refunds the stake.
- Games created before this rule update retain the earlier fixed 250-point maximum, including their pregame replacement revisions. Newly created games use progression. My Bet and the amount modal show the applicable maximum. Prior settled betting history counts toward progression.
- The official eight, full-time offense participants and anyone substituted out of this match cannot bet. Only the official eight receive player rewards.
- Predictions open after teams are finalized. The bot confirms roster Steam IDs on the exact assigned server, including players already connected and players on a lobby map before the selected map loads. Full-time offense and other spectators do not count toward eight; an official player spectating still counts as connected.
- All eight confirmed present starts one full two-minute window. Gameplay does not shorten it. Disconnects, duplicate events and restarts do not extend the deadline.
- An authorized in-game `!rs` delays roster queries until 15 seconds after the restart command is sent. If players are missing, scheduled checks run again at two minutes after that command, then every minute. Connection logs can prompt an earlier confirming query after the initial 15 seconds. The betting countdown still starts only when all eight are confirmed; `!rs` never starts or restarts it. Matches that do not use `!rs` retain the normal 15-second polling interval.
- Successful pregame substitutions, shuffles, map changes and starting-order changes refund the old market and create updated controls. Substitutions use the final balanced teams; captain substitutions preserve the outgoing player's team. Changes during live play refund without reopening.
- Original Blue / Team 1 and Red / Team 2 identities remain fixed across halftime colors.

## Payouts and corrections

Correct bettors first receive their stakes back. The remaining pot is allocated 70% proportionally to correct stakes, 25% equally to the winning four and 5% equally to the losing four. A tie uses 90% for correct bettors and 10% equally among the eight players. Integer rounding uses largest remainders with stable tie breaking, conserving the full pot. If nobody picked correctly, all stakes are refunded and there are no player rewards. No bets means no rewards.

If an owner corrects a result, previously credited points stay with their recipients, spent or unspent. Each person receives only any positive difference between their corrected entitlement and their cumulative settlement credits. Additional points are explicitly funded by the house and recorded in the ledger. Returning to a previously used result cannot repeat already-issued credits. There are no forced clawbacks or negative balances.

## Configuration and rollout gates

```env
PREDICTIONS_ENABLED=0
PREDICTIONS_OWNER_ID=your_discord_user_id
```

Predictions use the existing resolved `DB_PATH` / `ELO_DB` / `elo.db` handle. Five additive tables hold accounts, markets, bets, append-only transactions, and small schema/pause metadata. No database consolidation is involved. Existing SQLite-aware backups now receive the configured ELO path.

The progression update advances prediction schema version 1 to 2 in one transaction on startup, replacing the bet table's former 250-point constraint while preserving rows, IDs and immutable transaction history. ELO tables and SQLite's global `user_version` are untouched. Back up the configured database before updating. Amounts remain positive safe integers, with safe-integer balance and total-game-stake checks; these are numerical representation safeguards, not a progression ceiling. Progress is calculated from retained settled bets and is not duplicated by startup or corrections.

Before separately authorized enablement:

1. Confirm raw RCON `status` output on every supported pickup server, including its complete roster footer. Missing/ambiguous Steam links must not trigger eight.
2. Verify `World triggered "Match_Begins_Now"` on the current servers and modes. The four bundled real logs demonstrate that this differs from map load and warmup kills. This event tracks match phase; it never closes betting early.
3. Configure a unique remote log directory for each competitive server using `HL_REMOTE_LOG_DIR_<SERVERKEY>` (or the existing shared setting only when it uniquely identifies that endpoint). The existing `HL_SSH_*` credentials must allow read-only access. Before material match changes, the bot reads complete logs from a persisted map/log anchor through the latest file, complementing lossy UDP delivery. A same-map halftime reload never erases an earlier start. Missing continuity, logs older than 30 seconds, shared directories, more than 16 required files, oversized/incomplete logs or a wrong map yield unknown phase and cannot authorize reopening. The initial anchor requires a trusted selected-map log event; phase uncertainty freezes changes for owner resolution.
4. Exercise normal/tied matches, standard and captain substitutions, shuffles, map/order changes, both halftime color policies, report corrections, duplicate confirmations, bot restarts, monitoring loss and blocked DMs on staging. Use separate Discord users to verify privacy.
5. Restore an SQLite backup and reconcile accounts, stakes, original deadlines and settlement versions.

Current-server credentials were unavailable during development. Unit/fixture tests do not substitute for those operational checks. No plugin installation or server configuration mutation is included.

## Owner commands

Only `PREDICTIONS_OWNER_ID` can use these controls; the Discord admin role alone does not qualify. Missing owner configuration disables financial administration. Commands work in DM as well as the normal command router. Financial output and confirmation are delivered privately; blocked DMs never cause a public fallback. Use raw Discord IDs or mentions for account targets.

| Command | Action |
|---|---|
| `!pred unresolved` | Privately list open, countdown, closed/awaiting-result and review-required games, with IDs, server, revision, locked points, deadline and review reason. Long lists arrive as a text attachment; an empty list confirms there are none. Works with predictions disabled. |
| `!pred status <matchId>` | Inspect current state, revision, phase, deadline and review reason. |
| `!pred audit <matchId\|userId>` | Download private transaction history and market details. |
| `!pred void <matchId> <reason>` | Refund and void an unsettled or reviewed market. |
| `!pred correct <matchId> <blue\|red\|tie> <reason>` | Apply a house-funded correction matching the completed official report. Fix the report first. |
| `!pred adjust <userId> <signedPoints> <reason>` | Audited grant/deduction. Deductions cannot create a negative balance. |
| `!pred pause <reason>` / `!pred resume <reason>` | Persistently stop/resume new and edited bets. Deadlines, pre-lock cancellation, refunds and settlement continue. |
| `!pred retain <matchId> <reason>` | Explicitly allow deleting a settled match while preserving all financial snapshots and history. |

Mutations require an owner-bound confirmation expiring after 60 seconds. Changed relevant state invalidates the preview. Repeating the same confirmation returns its stored result. There is no manual early-close command or selective owner refund in V1.

## Recovery and rollback

The database is authoritative even when Discord delivery fails. Unpublished match cards retain their destination for startup/periodic retry. All-eight candidates from log events are confirmed with a complete server roster query before persisting a deadline. On restart, expired deadlines close immediately. Unfinished open/countdown markets with uncertain connection history freeze for review; their original deadline is retained. Do not infer the first all-eight time from a reconnect poll or grant a fresh window. The owner can void/refund a reviewed unsettled market. Completed official results retry settlement independently of delayed ELO writes. Changed reports freeze financial settlement for owner correction.

Unexpected maps, incomplete presence monitoring and unknown phase prevent automatic reopening. Original locked bet inputs, allocations, grants, corrections and house funding remain auditable. Match deletion/purge cannot erase unresolved financial dependencies, and deleting an allowed match retains prediction history. Identity merge tools refuse existing prediction accounts pending a dedicated merge policy.

Roster queries retry up to three times, with two seconds between attempts, before freezing an unresolved market for unavailable monitoring. A failed query cannot start a countdown from cached connection data. Replies invalidated by a map/restart event require a fresh query. Existing deadlines continue during retries and the `!rs` settling period. Already reviewed markets stay frozen after an update; inspect them with `!pred status`, then use owner void/refund for a disposable test match and create a new pickup.

For rollout rollback, disable creation with `PREDICTIONS_ENABLED=0` while leaving this subsystem installed: My Bet, deadlines, owner voids and outstanding settlement must remain available. Resolve outstanding stakes before removing code. No historical matches receive retroactive markets or rewards.
