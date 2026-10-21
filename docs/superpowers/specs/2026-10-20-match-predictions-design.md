# Match predictions — approved design

Status: approved for isolated implementation on October 20, 2026. Deployment and production data changes are not authorized.

## Purpose and scope

Add low-friction, private predictions to pickup matches. Spectators earn points through predictions and players share part of losing stakes. Points are separate from ELO. Use new tables in the existing configured `elo.db`, not a new database file. Database consolidation, compression, and historical stats cleanup are separate future projects.

This document records the approved rules and implementation decisions. Deployment and production data changes require separate approval.

## Established requirements

- Every person starts with 1,000 free prediction points, granted once.
- Red, Blue, and Tie buttons on the match message. October 21 approved rule: new games start each person's maximum at 100 points, increasing by 10 per distinct settled game bet on, without a fixed upper cap. Existing rule-version-1 games keep their 250-point maximum through any replacement revisions.
- One active pick per person per current roster revision. Picks and amounts remain private.
- My Bet privately displays the pick, stake, available balance, and lock status; users can change or cancel while open.
- Participants cannot bet on their match.
- Betting opens after rosters are finalized. When all eight official roster players are present on the assigned game server, a two-minute closeout countdown begins. This replaces the fixed ten-minute window.
- The countdown runs for the full 120 seconds even if competitive play begins during it. Competitive-start evidence never shortens this deadline. At the deadline, placement, edits, and cancellation stop; settlement waits for the official result.
- Successful pregame substitutions refund bets and reopen predictions for the updated teams.
- Decisive result: return correct stakes, then distribute the remaining pot 70% to correct bettors by stake, 25% evenly to winning players, and 5% evenly to losing players.
- Tie: return correct stakes, then distribute the remainder 90% to correct bettors by stake and 10% evenly to players.
- Owner-only financial administration, with recorded refunds and corrections.

## Approved V1 choices

1. Support existing finalized 4v4 pickups, including captain drafts and ADL when they use that roster shape. Exclude 1v1 and other roster sizes.
2. Defer ELO-based payout odds, monthly activity bonuses, public leaderboards, website UI, and reward multipliers. Existing displayed ELO odds can remain informational. Record settled bets so bonuses can be designed later.
3. For rule-version-2 games, stake must be a positive whole number no greater than `100 + 10 × distinct settled games bet on` and available funds. All settled outcomes count, including no-correct-bettor refunds. Cancellations, voids, pregame refunds, edits, duplicate reports, player rewards and correction versions do not earn additional progression. Keep previously earned progress through result review. Existing rule-version-1 games retain a fixed maximum of 250. Editing replaces the stake rather than adding an allowance. Numerical safe-integer safeguards remain in force.
4. Grant the initial balance lazily on first interaction or first player reward, rather than creating accounts for all Discord members at launch. Never regrant on leaving/rejoining.
5. Exclude full-time offense participants from betting, but give player payout shares only to the eight official roster players. Offense participants do not count toward the eight-player countdown.
6. Any person who has appeared as a participant in any roster revision of a match remains ineligible to bet on it, even after being substituted out.
7. A successful pregame shuffle or any effective roster/team/assigned-server/map/starting-order change follows the same refund-and-reset policy as a pregame sub. A repeated finalization with identical terms is a no-op. These reset triggers are approved.
8. After competitive play starts, a roster change voids predictions and refunds original stakes; betting never reopens during live play. A normal second-half side swap is not a roster change.
9. No correct bettors: refund all stakes and pay no player shares. No bets: no points move. If every stake is correct, return stakes; there is no remaining pot to share.
10. No automatic time-based fallback closing window before all eight arrive. Owner can void a stalled market. Competitive-start evidence records match phase but does not close betting, including if it arrives before all eight are confirmed. An owner cannot manually shorten the normal two-minute window; an exceptional financial void refunds the market instead.
11. Owner corrections never claw back credited payouts or create debt. Retain all prior credits and pay only positive differences between corrected entitlements and cumulative settlement credits already issued to each recipient. Explicit audited house funding covers the additional points. Repeated/successive corrections cannot pay the same entitlement twice.
12. Public messages show market status, deadline, and the official outcome. They never show individual stakes, picks, balances, per-person payouts, or outcome-specific pot totals. Defer public financial aggregates to avoid unnecessary inference in sparse markets. Owner financial audit access is an explicit exception to user privacy.

## User experience

The existing Match Ready/Match Updated embed gains one row: Blue, Red, Tie, My Bet. Label colors as the original teams in that match card; they are not the physical team colors after halftime.

October 21 approved display update: include the existing ELO matchup estimate in the Blue/Team 1 and Red/Team 2 button labels, such as `Blue / Team 1 · 58%` and `Red / Team 2 · 42%`. Use `lib/odds`' actual-team rating lookup and split summary; store the resulting complementary percentages in the prediction snapshot for that revision. Recompute for updated pregame teams. Retain original team identities across halftime and do not let unrelated rating changes alter an existing estimate. Tie and My Bet remain unchanged; missing/invalid stored estimates fall back to the original labels. Do not add an odds field to the embed or change financial rules.

Selecting an outcome opens a private amount modal, prefilled with the existing stake or 100 points for a new bet. Submission is the final placement/edit action. The private response confirms match, selected team, stake, remaining balance, and closing status. No stake is reserved just by opening the modal.

My Bet gives a private view with Change and Cancel buttons while open/counting down. Cancel refunds the stake immediately. After lock, My Bet still works but editing and cancellation do not. After settlement it displays that user's outcome and payout.

The embed initially says: "Predictions open — closes 2 minutes after all 8 roster players join." Once triggered, use a Discord timestamp for the exact deadline; no per-second message edits. Closed markets disable outcome buttons but keep My Bet enabled.

Old messages and modals carry the market ID and roster revision. Every submission checks current database state, eligibility, deadline, and funds. A stale modal cannot place a bet on a replacement market. Discord delivery failure never rolls back a committed financial operation; a repeated interaction returns the already-recorded result.

Approved follow-up: `!bank` and its alias `!points` delete the server command when permitted and DM the caller their available/held/total points, personal limit, last five bets with actual returns/net, and player rewards from their last five settled prediction games as an official roster player. Edits replace the same bet; refunded/cancelled bets remain labelled. Include zero player rewards and retained correction credits, excluding grants and balance adjustments. Works in DMs and with new predictions disabled. Long statements use a private attachment; blocked DMs produce only a generic public notice, with no financial details. My Bet continues to provide private balance access.

## Market lifecycle and connection tracking

States: `open`, `countdown`, `closed`, `settled`, `void`, `review_required`. Only open/countdown markets before their stored deadline accept changes. Review-required markets accept no bets and require owner action to resolve uncertainty.

1. Persist a valid match before creating its market and attaching buttons. Capture original team IDs, offense IDs, linked Steam IDs, map, canonical server key, `team1Starts`, and payout rule version. Persist enough prediction context to recover without AutoRecap's in-memory armed state.
2. Track distinct linked roster players currently present on the exact assigned server. Never use aliases or total server population. Support multiple Steam IDs belonging to the same Discord player without counting them twice. Require eight distinct roster identities; one Steam ID linked to two roster accounts cannot count for both. Missing or ambiguous mappings prevent automatic countdown activation and produce owner diagnostics. Presence means authenticated connection, including a roster player spectating; it does not require joining the correct physical color.
3. Seed presence using an authoritative raw RCON `status` roster query, then maintain it with trusted HLDS connect/disconnect events and periodic reconciliation (every 15 seconds for open/countdown markets). Serialize reconciliation with events so an older response cannot overwrite newer evidence. Distinguish connection sessions and server/log instances, reject incomplete status replies, and reconcile pending authentication. A stale disconnect from an earlier session must not remove a newer connection.
4. As soon as all eight are confirmed present, persist `closes_at = now + 120000` once. If all eight are already present at market creation, start immediately. Disconnects, duplicate packets, map reloads, or duplicate callbacks do not extend the deadline.
   - October 21 clarification: an authorized `!rs` delays roster checks for 15 seconds from sending the restart command. Check again at the two-minute mark, then every minute while waiting; connection logs may prompt an earlier fresh query after the settling delay. Outside this restart schedule, retain normal 15-second reconciliation. `!rs` does not start a betting countdown; all eight still receive the full two-minute window after confirmation. Retry incomplete/failed queries up to three times with two-second gaps before freezing for unavailable monitoring. Never trust cached presence after a failed query or extend an existing deadline.
5. On expiry, atomically close. Every bet/edit/cancel checks the stored deadline even if the timer callback is delayed.
6. Record authoritative competitive-start evidence for roster-change classification only. Never close early because of that event, a kill, a score, map load, or replay recording. Keep the first competitive start for the match across halftime/map reloads; it must not revert to pregame or reopen betting.
7. On startup, load unfinished markets, enforce expired deadlines immediately, and reconcile presence and match state before enabling mutations. Never give a fresh two minutes after restart.
8. If downtime or monitoring loss makes the original all-eight trigger/deadline or a material roster change uncertain, freeze mutations and set `review_required`; do not grant a fresh two minutes from a reconnect poll. Owner can void/refund. Gameplay within the approved two-minute window is allowed and is not itself grounds for review. A missing competitive-start event affects confidence in whether a roster change may reopen betting; a valid persisted deadline remains enforceable without that event. Presence polling alone does not reconstruct missed history.

### Required discovery before enabling the feature

The bundled real log fixtures contain `World triggered "Match_Begins_Now"` in all four files under `parser/upstream/test/`. The upstream parser recognizes it as `PrematchEnd`; the original `services/hldsLogs.js` ignored it; this implementation now recognizes it. `L0522000.log` starts its map at 00:02:42 and emits the event at 00:04:07; `L0522001.log` starts its map at 00:19:15 and emits the event at 00:19:58. Both contain warmup kills before that event. Map load/replay-start and first kill therefore do not establish competitive start in those recorded matches.

Before rollout, verify the existing event on every supported current server/mode, its delivery to the bot, its relation to actual playable state, and how to reconstruct match phase after reconnect. There are no configured RCON/SSH credentials in this review checkout, so present installation coverage and recovery behavior remain unverified. Do not add a plugin unless this discovery demonstrates a gap and the extension is separately reviewed. Never infer prematch duration or live phase solely from map elapsed time.

The live receiver uses UDP and stamps events with receipt time. Preserve source log timestamps plus receipt time, server/log instance and ordering context where available; tolerate duplicate, delayed and reordered events. A global packet timestamp is not per-server monitoring health. Durable log evidence or an authoritative phase query must support recovery; otherwise roster-change classification is unknown and cannot authorize reopening. None of these phase signals shorten the full betting countdown.

`services/rconClient.js` preserves the formatted `status` response for existing callers and adds a separate raw roster interface for presence.

## Roster changes and substitutions

Compare effective final rosters, not intermediate `!sub` writes: standard substitutions can rebalance both teams, while captain substitutions preserve team assignment. Validate distinct final roster IDs before mutation. Compute the final result first, then commit all roster/offense/scenario writes and the market transition together on `elo.db`; update player locks and in-memory rosters only after commit. Failed/no-op commands must not change either financial or memory state.

Cover `commands/sub.js`, `commands/shuffle.js`, `commands/setmap.js`, and armed-match starting-order changes through `commands/settings.js` / `autoRecap.updateTeam1Starts`. `matches.status='in_progress'` begins at finalization and cannot distinguish pregame from competitive play. A material change with uncertain phase goes to review without reopening. Server/map changes observed outside these commands must also invalidate assumptions; a normal same-map halftime reload must not reset the market.

For a pregame change, in the same SQLite transaction as the final roster write: refund active stakes exactly once, mark the old market void with its reason, create the next revision, and snapshot final teams. Reconcile presence for the new market; if all eight are already present it gets a fresh two minutes.

The incoming substitute's old spectator bet is refunded along with everyone else's and they become ineligible. Failed or no-op commands do not refund. In-flight modals for the old revision are rejected.

After live play begins, a successful participant/team change voids the unresolved market and refunds stakes without reopening. Completed-match forced substitutions never silently rewrite historical payout recipients: flag affected settled markets for owner review. Automatic halftime side changes keep the original Blue/Red team identity.

Persist `team1Starts` as part of match terms and label Blue/Red as original Team 1/Team 2. Existing `lib/teamStart.js` supports both swapped and unchanged second-half colors. Settle against the canonical recorded winner, not an independent recomputation of physical-color scores.

## Payout calculation

Let `T` be total active stakes and `C` be stakes on the correct outcome. When `C > 0`, return `C` to correct bettors first. Split `R = T - C` using the established percentages; correct bettors' profit shares are proportional to their correct stakes.

Example: T=1,000; C=400; R=600. Return 400, distribute 420 to correct bettors, 150 to the winning four, and 30 to the losing four. Total credited is exactly 1,000.

Use integer arithmetic. Allocate percentage pools using largest remainders, then allocate each pool to recipients using largest remainders. Break equal remainders by a documented stable pool order (bettors, winners, losers; bettors, players for ties) and then Discord ID ascending as text. Persist the complete allocation. Never lose or create points through rounding.

Player recipients come from the eligible market's frozen official roster. No ELO, ADL, RNG, or streak multiplier changes point payouts. Minting occurs only for the one-time grant, explicit owner adjustments, or audited house funding of corrections; ordinary settlement redistributes stakes.

## Persistence in elo.db

Use `elo.db`'s existing `better-sqlite3` handle for operations that must share a transaction with match changes. Add four financial tables plus `prediction_meta` for schema/pause metadata; do not create a second points database.

| Table | Main fields and responsibilities |
|---|---|
| `prediction_accounts` | `discord_id` primary key, nonnegative integer `balance`, created/updated timestamps. Cached balance must reconcile to transaction history. |
| `prediction_markets` | Integer market ID, match ID, revision, state, team/offense/Steam identity snapshots, server key, map, starting order, opened/countdown/closed/live timestamps, monitoring/instance evidence, close reason, rule version, latest settlement version, persisted allocation/result JSON, Discord channel/message IDs, review reason. Unique `(match_id, revision)` and at most one nonterminal market per match. |
| `prediction_bets` | Integer bet ID, market ID, Discord ID, pick (`blue`, `red`, `tie`), integer stake, status (`active`, `cancelled`, `refunded`, `settled`), timestamps. Unique `(market_id, discord_id)`; edits update this row and ledger records preserve change history. |
| `prediction_transactions` | Integer ID, account ID, signed amount, kind, market/bet IDs where relevant, unique operation key plus entry key, actor ID, mandatory reason for owner actions, settlement version, timestamp, private operation-result metadata for replay. Append-only. |

Point mutations are synchronous short SQLite transactions: validate current state, update account/stake/market, append ledger entries, commit. Perform Discord and RCON I/O outside transactions. Prevent concurrent overspending through guarded database writes, not just JS locks.

Model escrow through active stakes; it needs no extra table. Verify `sum(account balances) + sum(unsettled active stakes) = net grants, owner adjustments and house issuance`, including explicit house issuance. All repeated operations and settlement retries must be idempotent. A transaction is never partially applied.

Indexes: unique keys above, markets by state/deadline, bets by market/status, transactions by account/time and market/settlement version. Add only indexes supported by these access patterns.

Retain prediction records if a match is deleted; do not cascade-delete financial history. Include schema version metadata using a prediction-specific migration mechanism; do not overwrite global SQLite `user_version` without auditing other users.

Keep original locked bet inputs and every settlement allocation immutable in versioned append-only transaction metadata, including zero-value/no-bet operations, so retries and repeated corrections can be reconstructed without relying on an overwritten latest-result JSON. Persist operation results for no-op mutations as well as debits. Retain the one-time grant evidence even if an account is later renamed or administratively retired. Reject reuse of a historical match ID for a new match with retained prediction history. Account-merging tools must refuse affected prediction accounts until an explicit merge policy is designed; do not silently create another starting grant or rewrite audit actors.

## Results, refunds, and owner tools

Manual and automatic results converge through `commands/admin.js`'s report path. Settle from the persisted completed match result, independently of delayed Gentle ELO allocation. Record financial result observation/review invalidation in the same transaction as official result persistence; settlement may then retry from persisted state after a crash. Insert this boundary before Discord, upload or delayed ELO scheduling failures can skip the prediction hook. Ordinary duplicate `!report` currently unreports/reapplies ELO; prediction deduplication must not depend on existing report behavior or command/interaction identity.

- First valid result settles a closed eligible market once. If a result arrives before its stored betting deadline or while waiting for all eight, freeze it for review; never silently shorten the approved window or automatically settle inconsistent lifecycle evidence. Eligibility means betting respected the original deadline and accepted terms, not that all bets preceded gameplay.
- Repeated identical reports do nothing financially.
- A changed report/fixreport marks the market review-required; ordinary ELO admins cannot automatically authorize a house-funded correction.
- Owner correction recalculates entitlements from the original locked bets and credits each recipient only max(0, corrected entitlement minus cumulative settlement credits already issued). Prior credits remain theirs, spent or unspent. Record each additional credit and the matching house issuance atomically, with actor/reason/result version and an immutable allocation snapshot. A no-correct-bettor refund is a correctable settlement, distinct from a terminal void.
- Defer individual owner refunds in V1. Users can cancel their own bets before closure; exceptional owner refunds operate on the whole market. After settlement, corrections operate on the whole settlement.
- Cancelling/deleting an unresolved match refunds its stakes. Deleting a settled match requires owner resolution first; retain audit history. Bulk purge must refuse while prediction history would be orphaned or financial resolution is pending; it must never erase prediction history.

Owner command namespace (all financial/admin actions require configured owner ID, not the admin role):

| Command | Behavior |
|---|---|
| `!pred unresolved` | Privately list all unfinished prediction games, locked stakes, deadline and review reason. Owner-only and read-only; available while disabled. |
| `!pred status <matchId>` | Private owner diagnostic: state, deadline, revisions, totals, result/review status. |
| `!pred void <matchId> <reason>` | Void an unresolved market and refund stakes. Settled markets use house-funded correction handling. |
| `!pred correct <matchId> <blue|red|tie> <reason>` | Correct prediction settlement against the official recorded result; refuse a mismatch and direct owner to correct the match report first. |
| `!pred adjust <user> <signedAmount> <reason>` | Explicit recorded grant/deduction; signed safe integer, preview before confirmation. |
| `!pred audit <matchId|user>` | Private ledger and settlement details for the owner. |
| `!pred retain <matchId> <reason>` | Authorize deleting a settled match while retaining its financial history. |
| `!pred pause <reason>` / `!pred resume` | Persistently pause new/edited bets globally. Cancellation before lock, refunds, deadlines, and settlement continue; resume never extends deadlines. |

Prefix commands cannot send ephemeral channel replies. Deliver detailed owner output and confirmation through DM, or an owner-only ephemeral interaction; if private delivery fails, do not post private data publicly. Mutations use a preview and owner-bound confirmation button; already-expired deadlines are still enforced at confirmation. Confirmations expire after 60 seconds and revalidate current versions. A missing owner ID disables financial administration.

## Operations and rollout

- Settings: `PREDICTIONS_ENABLED=0` by default and `PREDICTIONS_OWNER_ID`. Defer the optional private audit channel; use private owner interactions/DMs and the ledger. Starting grant, stake policy, countdown and payout percentages are versioned rules. October 21 explicitly approves progressive limits for rule version 2 and a transactional prediction-only schema upgrade replacing the former fixed bet constraint. Preserve existing rule-version-1 games, all bet IDs, financial history and unrelated ELO data.
- No retroactive markets or awards for historical matches. Disabling creation does not abandon outstanding stakes: recovery, My Bet, refunds, deadlines, and settlement remain operational.
- Reuse SQLite-aware compressed backups, which already include committed WAL changes. Pass the resolved `DB_PATH` / `ELO_DB` path to `scheduleBackups`; its current invocation uses the literal default `elo.db`. Verify restoring a backup preserves balances, locked stakes, and settlement versions.
- Log market state transitions, operation IDs, and errors without ordinary users' picks/stakes in public logs. Private audit records may contain financial details.
- Roll out disabled, test with a staging copy and controlled matches, then enable for new pickups. Production deployment is outside the approved implementation scope.

## Acceptance criteria

- Original ELO behavior is unchanged; points never influence team balancing or ratings.
- New account receives exactly 1,000 once, including concurrent first use.
- User can place/edit/cancel privately and cannot overspend across simultaneous matches.
- Participants, including offense and earlier roster revisions, cannot bet.
- Only the correct eight linked players on the assigned server trigger one persisted 120-second deadline.
- A competitive start during countdown does not shorten its 120 seconds. Deadline enforcement, monitoring gaps, restarts, and stale interactions cannot admit bets after the approved deadline or silently restart that countdown.
- Pregame sub/shuffle refunds exactly once and snapshots the final teams; live changes void without reopening.
- Every outcome, rounding case, no-correct-bettor case, and retry preserves the accounting invariant.
- Duplicate reports never duplicate payouts; owner corrections and house-funded corrections preserve prior credits.
- Match deletion/purge cannot destroy financial history or strand stakes.
- Private delivery and Discord message failures do not leak bets or corrupt balances.

## Approval record

The user approved the full 120-second window even during gameplay, official-eight-only player rewards, exclusion of offense and former participants from betting, pregame material-change refunds/reset, live-change refunds without reopening, no-correct-bettor refunds without player rewards, and house-funded corrections preserving all prior credits. The revised implementation plan is approved for execution inline in the isolated branch. Other V1 defaults above are the bounded implementation choices under that approval. Rollout requires separate authorization and installation-specific verification.

### Owner recovery for an initially unpaid reviewed game (October 21)

The owner requested settlement of a valid completed game whose predictions froze before recording a deadline. Add `!pred settle <matchId> <blue|red|tie> <reason>` through the existing owner-bound private preview/confirmation flow. It applies only to initially unpaid `review_required` games and validates completed official outcome, original team identities and selected map. Preview the original review reason, pot, active bet count, revision and recorded/missing deadline, explicitly accepting the frozen bets despite uncertain closure history. Confirm against unchanged report, market and bets; atomically audit the override and reuse normal payout rules without reopening bets, inventing an earlier deadline or changing ELO. Repeated confirmations/reports/restarts cannot duplicate credits. Voided games cannot be recovered; later corrections continue through `!pred correct`. Automatic monitoring/map recovery is outside this bounded follow-up.

Owner map-change follow-up: after verifying alchimy_lg was actually played for DH96AX, allow an explicit --accept-map-change flag after the settlement outcome and before a mandatory reason. Show both maps in the private confirmation and record them with acceptance in the ledger, preserving the original snapshot and all official outcome/team, stale-preview and duplicate-payout checks. Default map mismatches still block settlement.
