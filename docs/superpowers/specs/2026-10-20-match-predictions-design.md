# Match predictions — draft for review

Status: proposed design, not approved for implementation. Date: October 20, 2026.

## Purpose and scope

Add low-friction, private predictions to pickup matches. Spectators earn points through predictions and players share part of losing stakes. Points are separate from ELO. Use new tables in the existing configured `elo.db`, not a new database file. Database consolidation, compression, and historical stats cleanup are separate future projects.

This document includes recommended defaults for unresolved rules. They are proposals for review, not decisions the user has already approved. The accompanying implementation plan is also a draft.

## Established requirements

- Every person starts with 1,000 free prediction points, granted once.
- Red, Blue, and Tie buttons on the match message; maximum total stake of 250 points per person per match.
- One active pick per person per current roster revision. Picks and amounts remain private.
- My Bet privately displays the pick, stake, available balance, and lock status; users can change or cancel while open.
- Participants cannot bet on their match.
- Betting opens after rosters are finalized. When all eight official roster players are present on the assigned game server, a two-minute closeout countdown begins. This replaces the fixed ten-minute window.
- Successful pregame substitutions refund bets and reopen predictions for the updated teams.
- Decisive result: return correct stakes, then distribute the remaining pot 70% to correct bettors by stake, 25% evenly to winning players, and 5% evenly to losing players.
- Tie: return correct stakes, then distribute the remainder 90% to correct bettors by stake and 10% evenly to players.
- Owner-only financial administration, with recorded refunds and corrections.

## Recommended V1 choices to review

1. Support existing finalized 4v4 pickups, including captain drafts and ADL when they use that roster shape. Exclude 1v1 and other roster sizes.
2. Defer ELO-based payout odds, monthly activity bonuses, public leaderboards, website UI, and reward multipliers. Existing displayed ELO odds can remain informational. Record settled bets so bonuses can be designed later.
3. Stake must be a whole number from 1 through 250, no greater than available funds. Editing replaces the existing stake; it does not add another 250 allowance.
4. Grant the initial balance lazily on first interaction or first player reward, rather than creating accounts for all Discord members at launch. Never regrant on leaving/rejoining.
5. Exclude full-time offense participants from betting, but give player payout shares only to the eight official roster players. Offense participants do not count toward the eight-player countdown.
6. Any person who has appeared as a participant in any roster revision of a match remains ineligible to bet on it, even after being substituted out.
7. A successful pregame shuffle or any effective roster/team/assigned-server/map change follows the same refund-and-reset policy as a pregame sub. A repeated finalization with identical terms is a no-op.
8. After competitive play starts, a roster change voids predictions and refunds original stakes; betting never reopens during live play. A normal second-half side swap is not a roster change.
9. No correct bettors: refund all stakes and pay no player shares. No bets: no points move. If every stake is correct, return stakes; there is no remaining pot to share.
10. No automatic time-based fallback closing window before all eight arrive. Owner can close or void a stalled market. Live-play detection always closes it sooner if needed.
11. Balances may become negative only when reversing an already-issued payout during an owner correction. Negative balances cannot fund bets; later credits repay the deficit. This avoids silently minting points if a recipient already spent their payout.
12. Public messages show market status, deadline, and an aggregate settlement summary. They never show individual stakes, picks, balances, or per-person payouts. Owner financial audit access is an explicit exception to user privacy.

## User experience

The existing Match Ready/Match Updated embed gains one row: Blue, Red, Tie, My Bet. Label colors as the original teams in that match card; they are not the physical team colors after halftime.

Selecting an outcome opens a private amount modal, prefilled with the existing stake or 100 points for a new bet. Submission is the final placement/edit action. The private response confirms match, selected team, stake, remaining balance, and closing status. No stake is reserved just by opening the modal.

My Bet gives a private view with Change and Cancel buttons while open/counting down. Cancel refunds the stake immediately. After lock, My Bet still works but editing and cancellation do not. After settlement it displays that user's outcome and payout.

The embed initially says: "Predictions open — closes 2 minutes after all 8 roster players join." Once triggered, use a Discord timestamp for the exact deadline; no per-second message edits. Closed markets disable outcome buttons but keep My Bet enabled.

Old messages and modals carry the market ID and roster revision. Every submission checks current database state, eligibility, deadline, and funds. A stale modal cannot place a bet on a replacement market. Discord delivery failure never rolls back a committed financial operation; a repeated interaction returns the already-recorded result.

Optional public `!points` command is deferred because balances are private. My Bet provides balance access even when the user has not placed a bet.

## Market lifecycle and connection tracking

States: `open`, `countdown`, `closed`, `settled`, `void`, `review_required`. Only open/countdown markets before their stored deadline accept changes. Review-required markets accept no bets and require owner action to resolve uncertainty.

1. Persist a valid match before creating its market and attaching buttons. Capture original team IDs, offense IDs, linked Steam IDs, map, canonical server key, and payout rule version.
2. Track distinct linked roster players currently present on the exact assigned server. Never use aliases or total server population. Support multiple Steam IDs belonging to the same Discord player without counting them twice.
3. Seed presence using an authoritative raw RCON `status` roster query, then maintain it with trusted HLDS connect/disconnect events and periodic reconciliation (proposed: every 15 seconds for open markets). Serialize reconciliation with events so an older response cannot overwrite newer evidence.
4. As soon as all eight are confirmed present, persist `closes_at = now + 120000` once. If all eight are already present at market creation, start immediately. Disconnects, duplicate packets, map reloads, or duplicate callbacks do not extend the deadline.
5. On expiry, atomically close. Every bet/edit/cancel checks the stored deadline even if the timer callback is delayed.
6. Close immediately on authoritative competitive-start evidence, even before all eight or before countdown expiry. Warmup kills and ordinary map loads are not sufficient evidence by themselves.
7. On startup, load unfinished markets, enforce expired deadlines immediately, and reconcile presence and match state before enabling mutations. Never give a fresh two minutes after restart.
8. If activity during downtime or loss of game-state monitoring makes it impossible to establish that accepted bets preceded live play, set `review_required`. Owner can void/refund; do not automatically settle questionable bets. A successful RCON connection alone does not prove no game occurred during downtime.

### Required discovery before enabling the feature

The repo parses connect/disconnect events and knows assigned pickup servers. Its existing auto-recap map-load/replay-start logic does not establish a reliable competitive-start signal. Implementation must identify and test the actual HLDS/AMXX prematch-to-live signal on this installation. If it does not exist, add a minimal explicit server/plugin event as a separately reviewed extension, or keep rollout disabled. Do not substitute the first score or kill: either can be too late or warmup activity.

`services/rconClient.js` currently formats `status` into a map string. Presence requires a separate raw roster query, preserving existing callers' behavior.

## Roster changes and substitutions

Compare effective final rosters, not intermediate `!sub` writes: standard substitutions can rebalance both teams, while captain substitutions preserve team assignment.

For a pregame change, in the same SQLite transaction as the final roster write: refund active stakes exactly once, mark the old market void with its reason, create the next revision, and snapshot final teams. Reconcile presence for the new market; if all eight are already present it gets a fresh two minutes.

The incoming substitute's old spectator bet is refunded along with everyone else's and they become ineligible. Failed or no-op commands do not refund. In-flight modals for the old revision are rejected.

After live play begins, a successful participant/team change voids the unresolved market and refunds stakes without reopening. Completed-match forced substitutions never silently rewrite historical payout recipients: flag affected settled markets for owner review. Automatic halftime side changes keep the original Blue/Red team identity.

## Payout calculation

Let `T` be total active stakes and `C` be stakes on the correct outcome. When `C > 0`, return `C` to correct bettors first. Split `R = T - C` using the established percentages; correct bettors' profit shares are proportional to their correct stakes.

Example: T=1,000; C=400; R=600. Return 400, distribute 420 to correct bettors, 150 to the winning four, and 30 to the losing four. Total credited is exactly 1,000.

Use integer arithmetic. Allocate percentage pools using largest remainders, then allocate each pool to recipients using largest remainders. Break equal remainders by a documented stable pool order (bettors, winners, losers; bettors, players for ties) and then Discord ID ascending as text. Persist the complete allocation. Never lose or create points through rounding.

Player recipients come from the eligible market's frozen official roster. No ELO, ADL, RNG, or streak multiplier changes point payouts. Minting occurs only for the one-time grant or explicit owner adjustments; ordinary settlement redistributes stakes.

## Persistence in elo.db

Use `elo.db`'s existing `better-sqlite3` handle for operations that must share a transaction with match changes. Add four tables; do not create a second points database.

| Table | Main fields and responsibilities |
|---|---|
| `prediction_accounts` | `discord_id` primary key, signed integer `balance`, created/updated timestamps. Cached balance must reconcile to transaction history. |
| `prediction_markets` | Integer market ID, match ID, revision, state, team/offense/Steam identity snapshots, server key, map, opened/countdown/closed/live timestamps, close reason, rule version, latest settlement version, persisted allocation/result JSON, Discord channel/message IDs, review reason. Unique `(match_id, revision)` and at most one nonterminal market per match. |
| `prediction_bets` | Integer bet ID, market ID, Discord ID, pick (`blue`, `red`, `tie`), integer stake, status (`active`, `cancelled`, `refunded`, `settled`), timestamps. Unique `(market_id, discord_id)`; edits update this row and ledger records preserve change history. |
| `prediction_transactions` | Integer ID, account ID, signed amount, kind, market/bet IDs where relevant, unique operation key plus entry key, actor ID, mandatory reason for owner actions, settlement version, reversal reference, timestamp, private operation-result metadata for replay. Append-only. |

Point mutations are synchronous short SQLite transactions: validate current state, update account/stake/market, append ledger entries, commit. Perform Discord and RCON I/O outside transactions. Prevent concurrent overspending through guarded database writes, not just JS locks.

Model escrow through active stakes; it needs no extra table. Verify `sum(account balances) + sum(unsettled active stakes) = net grants and owner adjustments`, including signed reversals. All repeated operations and settlement retries must be idempotent. A transaction is never partially applied.

Indexes: unique keys above, markets by state/deadline, bets by market/status, transactions by account/time and market/settlement version. Add only indexes supported by these access patterns.

Retain prediction records if a match is deleted; do not cascade-delete financial history. Include schema version metadata using a prediction-specific migration mechanism; do not overwrite global SQLite `user_version` without auditing other users.

## Results, refunds, and owner tools

Manual and automatic results converge through `commands/admin.js`'s report path. Settle from the persisted completed match result, independently of delayed Gentle ELO allocation. Persisted results are the retry source if the process fails after saving a result but before settling predictions.

- First valid result settles a closed eligible market once. If a result arrives while open, close it; settle only if monitoring establishes betting ended before play, otherwise require review.
- Repeated identical reports do nothing financially.
- A changed report/fixreport marks the market review-required; ordinary ELO admins cannot automatically authorize a financial reversal.
- Owner correction reverses the prior settlement and reapplies the corrected allocation against the original locked bets in one transaction. It never takes the stake a second time. Store each settlement version and its reversals.
- Individual refunds are allowed for unresolved markets. If any relevant refund happens after lock, void/refund the entire market to avoid selectively changing settled odds. After settlement, corrections operate on the whole settlement.
- Cancelling/deleting an unresolved match refunds its stakes. Deleting a settled match requires owner resolution first; retain audit history. Bulk purge must refuse while prediction history would be orphaned or financial resolution is pending; it must never erase prediction history.

Proposed command namespace (all financial/admin actions require configured owner ID, not the admin role):

| Command | Behavior |
|---|---|
| `!pred status <matchId>` | Private owner diagnostic: state, deadline, revisions, totals, result/review status. |
| `!pred close <matchId> <reason>` | Close an unresolved market early; cannot reopen it after live play. |
| `!pred void <matchId> <reason>` | Void an unresolved market and refund stakes. Settled markets use correction/reversal handling. |
| `!pred refund <matchId> <user> <reason>` | Refund one active pre-lock stake; after lock use whole-market void. |
| `!pred correct <matchId> <blue|red|tie> <reason>` | Correct prediction settlement against the official recorded result; refuse a mismatch and direct owner to correct the match report first. |
| `!pred adjust <user> <signedAmount> <reason>` | Explicit recorded grant/deduction; signed safe integer, preview before confirmation. |
| `!pred audit <matchId|user>` | Private ledger and settlement details for the owner. |
| `!pred pause <reason>` / `!pred resume` | Persistently pause new/edited bets globally. Cancellation before lock, refunds, deadlines, and settlement continue; resume never extends deadlines. |

Prefix commands cannot send ephemeral channel replies. Deliver detailed owner output and confirmation through DM, or an owner-only ephemeral interaction; if private delivery fails, do not post private data publicly. Mutations use a preview and owner-bound confirmation button; already-expired deadlines are still enforced at confirmation. Confirmations expire after 60 seconds and revalidate current versions. A missing owner ID disables financial administration.

## Operations and rollout

- Proposed settings: `PREDICTIONS_ENABLED=0` by default, `PREDICTIONS_OWNER_ID`, optional private audit channel ID. Starting grant, stake cap, countdown, and payout percentages are versioned constants for V1; changing them later requires an explicit migration/rule decision.
- No retroactive markets or awards for historical matches. Disabling creation does not abandon outstanding stakes: recovery, My Bet, refunds, deadlines, and settlement remain operational.
- Reuse SQLite-aware compressed backups, which already include committed WAL changes. Confirm the configured ELO file is covered. Verify restoring a backup preserves balances, locked stakes, and settlement versions.
- Log market state transitions, operation IDs, and errors without ordinary users' picks/stakes in public logs. Private audit records may contain financial details.
- Roll out disabled, test with a staging copy and controlled matches, then enable for new pickups. No production deployment is part of drafting this plan.

## Acceptance criteria

- Original ELO behavior is unchanged; points never influence team balancing or ratings.
- New account receives exactly 1,000 once, including concurrent first use.
- User can place/edit/cancel privately and cannot overspend across simultaneous matches.
- Participants, including offense and earlier roster revisions, cannot bet.
- Only the correct eight linked players on the assigned server trigger one persisted 120-second deadline.
- Live-start closure, deadline enforcement, monitoring gaps, restarts, and stale interactions cannot admit late bets.
- Pregame sub/shuffle refunds exactly once and snapshots the final teams; live changes void without reopening.
- Every outcome, rounding case, no-correct-bettor case, and retry preserves the accounting invariant.
- Duplicate reports never duplicate payouts; owner corrections and spent payouts are handled explicitly.
- Match deletion/purge cannot destroy financial history or strand stakes.
- Private delivery and Discord message failures do not leak bets or corrupt balances.

## Review checklist

Review the twelve recommended V1 choices first, especially: offense rewards, exclusion of former participants, live substitution policy, no-correct-bettor refunds, absence of a fallback time limit, correction debt, and delaying monthly bonuses/odds. Confirm the owner identity and the authoritative live-start signal before implementation/rollout respectively. All proposed defaults can be changed during this review.
