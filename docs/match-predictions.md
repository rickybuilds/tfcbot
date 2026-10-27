# Private match predictions

Predictions use points completely separate from ELO. The feature is disabled by default. This branch does not authorize deployment or changes to production data.

## Player rules

- Every Discord account receives 1,000 points once, on its first private balance interaction or player reward.
- Use Blue / Team 1, Red / Team 2, or Tie on the match card. One active pick, with a whole-number stake starting at a maximum of 100 points per game. Your personal maximum increases by 10 for each distinct settled game you bet on, up to 500 points: `min(500, 100 + 10 × settled games bet on)`. You must still have enough available points. Editing replaces the previous stake. Funds are reserved immediately. Existing bets above 500 remain valid; new bets and edits must respect the cap.
- New prediction cards show the ELO matchup percentages and fixed payout multipliers on the team buttons. These use the actual finalized rosters, are stored per roster revision and are recalculated after pregame substitutions/shuffles. They do not swap with physical halftime colors or change because ratings update elsewhere. Older games retain their original rules and labels.
- Wins, losses, ties and settled no-correct-bettor refunds count equally toward progression. Opening a modal, editing, cancelling, pregame refunds and voided games do not count; duplicate reports and corrections do not count again. Player rewards alone do not increase a player's limit. The higher limit does not itself grant points. Earned progression is retained when an already-settled result goes to owner review.
- My Bet privately shows the pick, stake, available balance, game state, current maximum and settled-game count. Change or cancel before closure; cancellation refunds the stake.
- Games created before this rule update retain the earlier fixed 250-point maximum, including their pregame replacement revisions. Newly created games use progression. My Bet and the amount modal show the applicable maximum. Prior settled betting history counts toward progression.
- The official eight, full-time offense participants and anyone substituted out of this match cannot bet. Only the official eight receive player rewards.
- Predictions open after teams are finalized. The bot keeps checking the exact assigned server until a complete status query confirms both the voted map and all eight roster Steam identities together. Players already connected count, but a lobby map does not start the countdown. Full-time offense and other spectators do not count toward eight; an official player spectating still counts as connected. Map comparison ignores case and surrounding whitespace, while different map variants remain different.
- All eight confirmed present on the voted map starts one full two-minute window. Gameplay does not shorten it. Disconnects, duplicate events and restarts do not extend the deadline.
- An authorized in-game `!rs` delays roster queries until 15 seconds after the restart command is sent. If readiness is incomplete, scheduled checks run again at two minutes after that command, then every minute. Connection logs can prompt an earlier confirming query after the initial 15 seconds. The betting countdown still starts only when all eight and the voted map are confirmed; `!rs` never starts or restarts it. Matches that do not use `!rs` retain the normal 15-second polling interval.
- Successful pregame substitutions, shuffles, map changes and starting-order changes refund the old market and create updated controls. Substitutions use the final balanced teams; captain substitutions preserve the outgoing player's team. Changes during live play refund without reopening.
- Original Blue / Team 1 and Red / Team 2 identities remain fixed across halftime colors.

## Private bank commands

Anyone can use `!bank` or its alias `!points`, including when new predictions are disabled. The bot deletes the command in a server when it has permission and DMs only the caller. The statement shows available points, points held in active bets, their combined total and the current personal betting limit.

It includes the caller's last five bets with pick, stake, status and actual settled returns/net profit or loss, plus player rewards from their last five settled prediction games as one of the official eight (including zero rewards). Cancelled/refunded bets are labelled; edits replace the same bet rather than creating extra history. Player rewards exclude grants and owner balance adjustments. Result corrections show the credits actually received, including retained earlier payouts. Games awaiting their first settlement do not appear in player reward history.

Long statements arrive as a private text attachment. If DMs are blocked, the server receives only a generic instruction to enable DMs, never financial details. The bot requires Manage Messages to delete the triggering command; missing permission does not prevent the private statement.

Both aliases log command usage to the configured audit channel (`AUDIT_CHANNEL_ID`), including the caller, actual alias, server name or DM, and time. Audit entries contain no balances, picks, stakes or rewards, and are attempted even if DMs are blocked. An unavailable audit channel does not prevent the private statement.

## Payouts and corrections

New markets use rule version 4. A team's multiplier is 0.75 divided by its displayed whole-number win probability, rounded to two decimals and bounded between 1.25x and 3.00x; a 0% estimate uses the 3.00x cap. Tie pays 2.00x. The multiplier includes the original stake, and each total return is rounded down to whole points. Losing bets are not refunded. The official winning four each receive 20 points and the losing four each receive 5; on ties all eight receive 10, including when nobody bets. Player rewards are separate from bettor payouts. The difference between the pot and all credits is recorded as house funding or house collection; these are issuance/removal entries, not a spendable reserve.

Earlier markets retain their original rules: correct stakes return first, and losing stakes are allocated 70/25/5 (or 90/10 for a tie) using largest-remainder rounding. If nobody picked correctly, version 3 collects the pot and versions 1–2 refund the bets; neither pays player rewards.

If an owner corrects a result, previously credited points stay with their recipients, spent or unspent. Each person receives only any positive difference between their corrected entitlement and their cumulative settlement credits. Additional points are explicitly funded by the house and recorded in the ledger. Returning to a previously used result cannot repeat already-issued credits. There are no forced clawbacks or negative balances.

## Configuration and rollout gates

```env
PREDICTIONS_ENABLED=0
PREDICTIONS_OWNER_ID=your_discord_user_id
```

Predictions use the existing resolved `DB_PATH` / `ELO_DB` / `elo.db` handle. Five additive tables hold accounts, markets, bets, append-only transactions, and small schema/pause/card-delivery metadata. No database consolidation is involved. Existing SQLite-aware backups now receive the configured ELO path.

The progression update advances prediction schema version 1 to 2 in one transaction on startup, replacing the bet table's former 250-point constraint while preserving rows, IDs and immutable transaction history. ELO tables and SQLite's global `user_version` are untouched. Back up the configured database before updating. Amounts remain positive safe integers, with safe-integer balance and total-game-stake checks. The separate 500-point betting cap is enforced when placing or editing bets. Progress is calculated from retained settled bets and is not duplicated by startup or corrections.

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
| `!pred settle <matchId> <blue\|red\|tie> <reason>` | Settle an initially unpaid reviewed game matching its completed official result, teams and map. Private confirmation explicitly accepts the frozen bets despite uncertain closure history. |
| `!pred correct <matchId> <blue\|red\|tie> <reason>` | Apply a house-funded correction matching the completed official report. Fix the report first. |
| `!pred adjust <userId> <signedPoints> <reason>` | Audited grant/deduction. Deductions cannot create a negative balance. |
| `!pred pause <reason>` / `!pred resume <reason>` | Persistently stop/resume new and edited bets. Deadlines, pre-lock cancellation, refunds and settlement continue. |
| `!pred retain <matchId> <reason>` | Explicitly allow deleting a settled match while preserving all financial snapshots and history. |

Mutations require an owner-bound confirmation expiring after 60 seconds. Changed relevant state invalidates the preview. Repeating the same confirmation returns its stored result. There is no manual early-close command or selective owner refund in V1.

For example, `!pred settle DH96AX red Verified official Red 90-80; accept frozen bets` privately previews the frozen reason, revision, bet count, pot and original deadline (including a missing deadline). Confirm within 60 seconds after reviewing the official game and frozen bets. The official report must be completed, match the chosen outcome, and have the same Blue/Red roster identities as the frozen prediction snapshot. By default, its map must also match. If you verified an actual map change and accept the frozen bets, place `--accept-map-change` immediately after the outcome and before the required reason: `!pred settle DH96AX red --accept-map-change Verified alchimy_lg Red 90-80; accept frozen bets`. The private confirmation displays both maps and the ledger records the explicit acceptance; the original prediction snapshot is preserved. This flag cannot override team/result checks or revive a void. It never reopens betting, fabricates an earlier deadline, changes ELO, revives a void, or replaces an existing settlement. The owner's reason, original freeze details and payout are recorded atomically in the transaction history. Relevant state/report/bet changes invalidate the preview; repeated confirmations/reports and restarts cannot repeat the payout. Use `!pred correct` for later corrections to already-paid games. This recovery does not repair the underlying server-monitoring/map failure.

## Recovery and rollback

The database is authoritative even when Discord delivery fails. Unpublished match cards retain their destination and complete original embed for startup/periodic retry. Destination and original payload queue atomically. If a queue write fails before any existing publication, the bot posts the original plain Match Ready embed without prediction controls so the pickup can proceed. Initial publication and retry share one in-flight job per prediction revision, then reuse the bound message for later updates. A slow initial Discord send cannot cause the retry loop to post a second set of controls. A stable Discord nonce also deduplicates a recently accepted send whose response was lost; this protection uses Discord's recent-nonce window, not an indefinite delivery guarantee. After binding, the same message refreshes to current betting status. Existing duplicate messages created before this fix are not automatically deleted. All-eight candidates from log events require a complete roster query confirming the selected map before persisting a deadline. On restart, expired deadlines close immediately and verified future deadlines continue at their original time. An unfinished game with no recorded deadline freezes for owner review. Do not infer the first all-eight time from a reconnect poll or grant a fresh window. The owner can void/refund a reviewed unsettled market. Completed official results retry settlement independently of delayed ELO writes. Changed reports freeze financial settlement for owner correction.

The official report supplies the winner automatically; no owner winner command is needed for a normal eligible game. A completed report can also resolve an unpaid game frozen for an unexpected server map, unavailable monitoring or a restart, provided its original deadline is recorded and has expired and the report matches the frozen Blue/Red teams, selected map and assigned server. Recovery and payout are atomic and audited; duplicate reports and startup retries cannot pay twice. A server returning to a lobby after the game therefore does not permanently block a valid payout. Reports are still recorded for reviewed games that do not qualify for automatic recovery. Missing/future deadlines, mismatched terms, other review reasons and corrections to already-paid games retain owner review. An update cannot reconstruct the missing betting window for an old frozen game; use the owner settlement/refund controls for those games.

Deleting an unresolved match atomically refunds its stakes, voids predictions and queues an update to the original match card. The card states that predictions are voided/refunded and disables outcome buttons while retaining My Bet. Failed bound-card edits remain queued in prediction metadata for startup/15-second retries, including while new predictions are disabled. An old edit completing out of order cannot discard the required refresh. The database rejects bets immediately even if Discord is unavailable. For an already deleted game whose card predates this fix, clicking My Bet refreshes that stale card; it does not repeat refunds.

Before the countdown starts, lobby maps and selected-map reloads remain a waiting state. After a deadline is recorded, a different map freezes betting until the official report can validate settlement or the owner resolves the issue. Stale map packets rejected by the presence tracker cannot freeze a valid countdown. Unknown match phase still prevents automatic reopening after material terms changes. Original locked bet inputs, allocations, grants, corrections and house funding remain auditable. Match deletion/purge cannot erase unresolved financial dependencies, and deleting an allowed match retains prediction history. Identity merge tools refuse existing prediction accounts pending a dedicated merge policy.

Roster queries retry up to three times per burst, with two seconds between attempts. Exhausting a burst logs a safe failure category and schedules another normal poll; it does not permanently freeze readiness detection. A failed query invalidates trusted presence and cannot start a countdown from cached connection data. Replies invalidated by a map/restart event require a fresh query. Existing deadlines continue during failed reads, retries and the `!rs` settling period. Existing reviewed games do not reopen for betting after an update; only the completed-result recovery described above can automatically pay an eligible frozen game.

For rollout rollback, disable creation with `PREDICTIONS_ENABLED=0` while leaving this subsystem installed: My Bet, deadlines, owner voids and outstanding settlement must remain available. Resolve outstanding stakes before removing code. No historical matches receive retroactive markets or rewards.

## Report authority and reliability

The completed `matches` row supplies the official Blue/Red/Tie winner. Reporting commits independently of prediction processing, and prediction initialization/publication failures do not roll back pickup creation or stop its locks, restart setup and AutoRecap arming. An old completed game's unresolved points do not reserve its server against the next pickup. If prediction storage is unavailable during creation, that pickup continues without prediction controls; no retroactive betting game is invented later.

Prediction reconciliation runs immediately after reporting, on startup and every 15 seconds, including with new predictions disabled. Each game's failure is isolated and retried independently. Every automatic payout verifies the completed result, original four-per-team identities, selected map and assigned server in its transaction. Stable repeats do not append payout operations or issue credits again. A changed winner on an already-paid match is detected from the DB and enters owner correction review; existing credits stay intact. Owner corrections use the same identity checks and retain previously audited acceptance of the exact map change.

The first completed report time in `matches.processed_at` is preserved across repeated/corrected reports and used to detect a result reported before the betting deadline even if its immediate callback failed. Placement, edits and cancellation are rejected as soon as the official row is completed, independently of stale Discord controls. Missing deadlines, early completed reports, genuine terms conflicts and unpaid-result changes continue to require owner review. No earlier all-eight time or replacement two-minute window is fabricated.

Before the first countdown, readiness rereads validated roster Steam links from the configured database, allowing a missing link repaired while players wait to take effect. Changes are audited and the mappings used are retained once the countdown starts. Duplicate/ambiguous identities cannot satisfy all eight. Stale live-start events receive the same rejection guard as stale map events. An authorized `!setmap` also updates the matching in-memory `!rs` target while preserving its timing and used state.

Point accounting totals use exact integer sums across accounts and ledger entries, including totals above JavaScript's safe-number and SQLite aggregate ranges. Individual balance/stake limits and all payout percentages remain unchanged. No new schema upgrade or environment variable is needed for these reliability changes.
