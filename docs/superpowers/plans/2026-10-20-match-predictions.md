# Match Predictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a draft for user review; do not execute before approval.

**Goal:** Add private pickup predictions with auditable points, durable betting deadlines, and safe refunds and settlement inside the existing ELO SQLite database.

**Architecture:** Separate storage, payout calculation, lifecycle/presence, and Discord interactions under `predictions/`. Existing match commands call narrow lifecycle hooks; all point mutations use the shared `elo.db` handle and short synchronous transactions. No new external database or package is planned.

**Tech Stack:** Node.js CommonJS, discord.js 14, better-sqlite3, existing HLDS/RCON integrations, Node test runner.

**Spec:** [Match predictions draft design](../specs/2026-10-20-match-predictions-design.md). Its unresolved choices must be reviewed before this plan becomes executable.

## Global constraints

- All prediction tables live in the existing configured `elo.db`; ELO and points remain separate.
- One-time starting grant: 1,000. Stake: whole number 1–250. One active pick per person per market revision.
- Countdown: 120,000 milliseconds after all eight official linked roster players are present on the assigned server. No fixed ten-minute window.
- Return correct stakes first. Remaining pot: 70% bettors / 25% winning players / 5% losing players; ties: 90% bettors / 10% official players.
- No correct bettors: refund all; no player payouts. Integer allocations conserve the complete pot.
- All picks/amounts/balances are private except authorized owner audit access.
- Owner-only financial actions; reason, preview, confirmation, and idempotency required.
- No monthly bonuses, ELO-priced odds, leaderboards, website work, 1v1 predictions, or database migration in V1.
- No product implementation or deployment as part of this planning request.

## Review focus

1. A stale modal or simultaneous click must not bypass closure, a roster revision, or balance limits (Tasks 2, 4, 5).
2. A player already connected before finalization, duplicate events, or a second server must not corrupt the eight-player condition (Tasks 1, 3).
3. Bot downtime, missing live-start evidence, or lost monitoring must not enable betting after seeing gameplay (Tasks 1, 3, 7).
4. Sub/shuffle, match deletion, and forced historical edits must not lose stakes or silently alter payout recipients (Tasks 5, 6).
5. Repeated/corrected reports and recipients who spent winnings must preserve the ledger without duplicate payouts (Tasks 2, 6).

## File responsibilities

Create:

- `predictions/schema.js`: idempotent additive schema migrations and indexes.
- `predictions/store.js`: account, bet, ledger, settlement and recovery queries using the injected DB handle.
- `predictions/payouts.js`: pure integer payout allocation.
- `predictions/presence.js`: raw server roster parsing, identity matching, and ordered reconciliation.
- `predictions/service.js`: lifecycle orchestration, durable deadlines, recovery, result and roster hooks.
- `predictions/interactions.js`: persistent button/modal routing, private responses, and private owner confirmations.
- `predictions/messages.js`: shared match-card action row and prediction status formatting.
- `predictions/admin.js`: owner command parsing, previews, auditing, pause/resume.
- `predictions/index.js`: subsystem factory and public facade.
- `test/predictionSchema.test.js`, `test/predictionPayouts.test.js`, `test/predictionStore.test.js`, `test/predictionPresence.test.js`, `test/predictionService.test.js`, `test/predictionInteractions.test.js`, `test/predictionAdmin.test.js`, `test/predictionIntegration.test.js`.
- `docs/match-predictions.md`: rules, setup, owner recovery and operational checks.

Modify:

- `index.js`: initialization, persistent interaction listener, dependency wiring, trusted HLDS routing, recovery/shutdown.
- `config.js`: feature enable flag, explicit owner ID, optional private audit channel.
- `services/rconClient.js`: separate raw status interface; keep existing formatted status behavior.
- `services/hldsLogs.js` and `services/autoRecap.js`: verified live-start hook only where supported by discovery.
- `commands/voteFlow.js`: persist final match before market creation/message attachment.
- `commands/sub.js`, `commands/shuffle.js`: final roster mutation/refund transaction and updated card.
- `commands/admin.js`: common report/fixreport and deletion integration.
- `commands/purgematches.js`, `lib/matchStore.js`, `lib/elo.js`: guarded deletion entry points where they can remove relevant matches; do not change ELO math.
- `commands/help.js`, `README.md`: brief player/owner documentation.
- Existing backup and match-flow tests only where behavior changes.

## Public interfaces

Use strings for Discord IDs/match IDs, safe integer milliseconds for timestamps, and safe integer points. `MarketRef` is `{ marketId: number, revision: number }`. `RosterSnapshot` contains `{ matchId, blueIds, redIds, offenseIds, steamIdsByDiscordId, serverKey, mapName }`. `OperationContext` contains `{ operationKey, actorId, reason?, now }`.

Factory: `createPredictions({ db, client, config, resolveSteamIds, queryServerRoster, clock, logger })` returns the facade below. Inject clock/network adapters for tests.

- `initialize()` applies schema and performs recovery; unresolved recovery cannot expose open mutations.
- `onMatchFinalized(snapshot, context)` returns current/new market, or no market if disabled/unsupported.
- `applyRosterChange({ matchId, nextSnapshot, applyMatchWrites, context })` synchronously runs final match writes plus financial invalidation in one DB transaction. `applyMatchWrites` must contain no network calls or nested transaction ownership.
- `onHldsEvent(event)` updates presence and accepts verified live-start evidence.
- `reconcileServer(serverKey)` fetches and reconciles authoritative presence; failures trigger monitoring safety rules.
- `onMatchReported({ matchId, result, now })` reads persisted official result and settles or requests review idempotently.
- `assertCanDeleteMatch(matchId)` refuses deletion of unresolved financial/history dependencies unless owner-resolution policy permits retaining the market snapshot.
- `applyMatchDeletion({ matchId, applyMatchWrites, context })` refunds unresolved stakes and performs allowed match deletion atomically while retaining ledger records.
- `handleInteraction(interaction)` returns whether it handled the prediction namespace.
- `handleAdminCommand(message, args)` handles `!pred` with owner authorization.
- `stop()` releases listeners/timers without resetting persisted markets.

## Task 1: Prove server presence and live-start inputs

**Files:** `predictions/presence.js`, `services/rconClient.js`, relevant HLDS/auto-recap adapter, `test/predictionPresence.test.js`, operational docs.

**Consumes:** existing normalized server keys, Steam links, trusted HLDS events. **Produces:** `queryServerRoster(serverKey) -> Promise<{ serverKey, mapName, steamIds, observedAt }>` and tested live-start event contract `{ type: 'prediction_live_start', serverKey, matchId, ts }` produced only from verified evidence.

- [ ] Capture sanitized real fixtures for raw RCON status and the actual prematch-to-live event. Establish how to query live/prematch state after reconnect. Do not assume map load, a kill, a score, or replay recording equals live play.
- [ ] Write failing tests: eight distinct linked roster players match; spectators/offense/unrelated server/multiple Steam IDs do not inflate the count; players already present are found; malformed/truncated RCON fails reconciliation; stale responses cannot replace newer events; warmup and halftime do not generate a first live-start.
- [ ] Run `node --test test/predictionPresence.test.js`; expect the new assertions to fail before implementation.
- [ ] Implement raw status and normalized presence adapters without changing existing formatted RCON responses. Document the proven live-start evidence and the monitoring-gap policy.
- [ ] Run the same test file; require all tests pass. If no trustworthy live-state signal exists, report the discovery and revise the plan for a minimal server event before proceeding to rollout; do not guess or silently broaden scope.
- [ ] Commit this task after implementation approval.

## Task 2: Build auditable accounts, escrow, and payout allocation

**Files:** `predictions/schema.js`, `predictions/store.js`, `predictions/payouts.js`; schema/store/payout tests.

**Consumes:** spec constants and roster snapshots. **Produces:** `PredictionStore(db)`, `ensureAccount(discordId, context)`, `placeBet({ marketRef, discordId, pick, stake, context })`, `cancelBet({ marketRef, discordId, context })`, `voidMarket({ marketId, context })`, `settleMarket({ marketId, outcome, context })`, `correctSettlement({ marketId, outcome, context })`; `calculatePayouts({ bets, outcome, blueIds, redIds }) -> { credits, pools, totalStaked }`. Mutators return persisted operation results and typed validation failures.

- [ ] Write failing schema/store tests for idempotent migrations, exactly-once grants, participant exclusion across revisions, safe-integer validation, cap/edit/refund behavior, concurrent cross-match spending, duplicate operation replay and account/ledger agreement. Use temporary databases and two handles for contention tests.
- [ ] Write payout tests for decisive/tie outcomes, 1,000/400 example, unequal stakes, one-point remainder ties, no bets, all correct, no correct bettors, and conservation across generated stake combinations. A correct bettor's returned stake is distinct from profit.
- [ ] Add settlement/reversal tests proving duplicate settlements are no-ops, correction reverses only prior credits, original stakes are not debited twice, debt blocks betting, and an injected mid-transaction failure leaves every balance/row unchanged.
- [ ] Run `node --test test/predictionSchema.test.js test/predictionPayouts.test.js test/predictionStore.test.js`; expect new tests to fail first.
- [ ] Implement additive migrations, minimal indexes, append-only ledger and pure largest-remainder math. All financial methods share the injected synchronous SQLite transaction; use guarded writes and unique operation/entry keys.
- [ ] Run the same test files; require pass and assert the escrow/account/grant invariant after each scenario.
- [ ] Commit this task.

## Task 3: Implement durable market lifecycle and recovery

**Files:** `predictions/service.js`, `predictions/index.js`, `test/predictionService.test.js`.

**Consumes:** Tasks 1–2. **Produces:** facade lifecycle methods, stored market revisions/deadlines, recoverable settlement queue through market state queries (no extra queue database).

- [ ] Write failing fake-clock tests for finalization, all-eight-already-present, exactly 120 seconds, duplicate events, disconnects without deadline extension, deadline checks despite timer delay, live-start closure, wrong-map/server rejection, monitoring outage/review state, and independent matches on different servers.
- [ ] Add restart tests: expired countdown closes immediately; unexpired countdown keeps original deadline; no restored market accepts bets until reconciled; uncertain downtime enters review; a completed persisted result settles exactly once after a crash. Existing historical matches never get new markets.
- [ ] Run `node --test test/predictionService.test.js`; confirm failures.
- [ ] Implement state transitions and a 15-second reconciliation loop for open markets. Persist before scheduling. Keep network I/O outside SQLite transactions; deduplicate active server polling. Capture immutable rule/identity snapshots.
- [ ] Run the same test file; require pass.
- [ ] Commit this task.

## Task 4: Implement private Discord betting interactions

**Files:** `predictions/interactions.js`, `predictions/messages.js`, `test/predictionInteractions.test.js`.

**Consumes:** store/service and `MarketRef`. **Produces:** shared action row builder, persistent `pred:` button/modal dispatcher, private My Bet/change/cancel views.

- [ ] Write failing tests for Blue/Red/Tie amount modal, default 100/existing stake, private confirmation, My Bet without a bet, change/cancel, participant rejection, insufficient funds, signed/decimal/oversized input rejection, stale revisions, forged identifiers, duplicate interaction delivery, disabled outcome buttons with working My Bet, and delayed modal submission at deadline.
- [ ] Add privacy tests proving public card/settlement output never includes individual stakes, picks, balances, or payout details. Simulate Discord response failure after commit and verify retry does not debit twice.
- [ ] Run `node --test test/predictionInteractions.test.js`; confirm failures.
- [ ] Implement persistent routing rather than process-local collectors for public betting controls. Revalidate state at submission; use interaction ID operation keys. Use existing discord.js dependency and current project's private-response conventions.
- [ ] Run the same test file; require pass.
- [ ] Commit this task.

## Task 5: Wire match creation, roster changes, and event routing

**Files:** `index.js`, `config.js`, `commands/voteFlow.js`, `commands/sub.js`, `commands/shuffle.js`, relevant HLDS adapter; integration tests.

**Consumes:** public facade and shared message builder. **Produces:** predictions for new supported matches and atomic pregame invalidation on final roster changes.

- [ ] Write failing integration tests for successful finalization only after DB persistence, failed persistence without a market, duplicate finalization without resets, one prediction message binding, standard rebalance and captain-preserving sub, shuffle, offense participant changes, and rejected/no-op commands without refunds.
- [ ] Test a bettor becoming the substitute, former participants attempting to bet, fresh countdown with eight already present, midgame sub voiding without reopening, and an old card/modal used after the update. Inject failure between final roster write and market reset; both must roll back.
- [ ] Test that prediction events are routed before unrelated queue/duel handlers can consume relevant disconnects, while server/match validation still rejects unrelated events. Normal 1v1 behavior stays unchanged.
- [ ] Run `node --test test/predictionIntegration.test.js`; confirm failures.
- [ ] Wire factory/config/dependencies and a persistent interaction listener. Reorder finalization so saved match/market precedes public betting controls. Refactor only the final synchronous roster-write sections needed for shared atomicity; leave Discord/RCON work outside the transaction. Bind updated cards and reject previous revisions.
- [ ] Run prediction integration and existing sub/shuffle/captain/queue tests selected from the repository; require pass.
- [ ] Commit this task.

## Task 6: Integrate settlement, owner corrections, and deletion safeguards

**Files:** `predictions/admin.js`, owner-confirmation routing, `commands/admin.js`, `commands/purgematches.js`, relevant deletion entry points, admin/integration tests.

**Consumes:** persisted official results, store reversal methods, lifecycle facade. **Produces:** common report settlement hook, private owner command suite, safe deletion/purge behavior.

- [ ] Write failing tests covering manual/automatic identical results, report retry, changed fixreport requiring review, Gentle ELO delay without prediction delay, unresolved market at report, and startup settlement retry after a saved result.
- [ ] Add owner tests: admin role alone refused; missing owner configuration refused; owner-bound preview expires after 60 seconds; replayed confirmation is idempotent; changed versions invalidate preview; required reason; private delivery failure does not post publicly. Cover close/void/refund/correct/adjust/audit/pause/resume and reject correction outcomes inconsistent with the official match.
- [ ] Add deletion tests for refunding unresolved stakes transactionally, refusing unresolved settled-history edits, blocking bulk purge with dependent markets, and retaining financial rows after permitted deletion. Forced completed sub must require owner financial review rather than silently changing recipients.
- [ ] Run `node --test test/predictionAdmin.test.js test/predictionIntegration.test.js`; confirm new tests fail.
- [ ] Implement common result hook after official result persistence, startup retry, whole-settlement reversals, and strict owner administration. Inventory all `DELETE FROM matches` entry points before adding shared guards. Keep original ELO authorization separate from point correction authorization.
- [ ] Run the same test files plus existing report/deletion tests; require pass.
- [ ] Commit this task.

## Task 7: Verify recovery, backups, privacy, and controlled rollout

**Files:** `docs/match-predictions.md`, `README.md`, `commands/help.js`, focused integration/backup tests.

**Consumes:** completed subsystem. **Produces:** verified operating instructions and a disabled-by-default release ready for explicit rollout.

- [ ] Add recovery tests for process interruption after debit, deadline persistence, saved result before settlement, and correction commit before Discord acknowledgement. Verify feature disabled and persistent pause do not strand refunds/settlements.
- [ ] Add a backup/restore test using the existing SQLite-aware backup path: restore accounts, escrow, market revisions and ledger; reconcile totals and verify no initial grants or settlements repeat. Confirm the configured ELO path is included by production backup scheduling.
- [ ] Run `node --test test/prediction*.test.js` and `npm test`; require pass. Record any pre-existing failures separately rather than claiming a clean suite.
- [ ] Review the final diff for raw bet logging, root/admin permission shortcuts, direct point-balance edits outside store transactions, unguarded match deletion, and timers that reopen markets on restart.
- [ ] Document setup, exact rules, owner commands, live-start evidence, monitoring outage recovery, debt handling, and rollback with outstanding stakes. Add concise help and README links.
- [ ] On a staging copy, exercise a complete match, tie, pregame sub/shuffle, live sub, owner correction, bot restart during countdown, and loss of HLDS/RCON monitoring. Verify private responses with separate Discord users and unchanged ELO outcomes.
- [ ] Keep `PREDICTIONS_ENABLED=0` until the live-start signal and staging checklist pass and the user authorizes rollout. Enable only new matches; do not create historical markets.
- [ ] Commit documentation/verification changes and report results for final review.

## Review and execution handoff

No implementation has started. Review the draft design choices and this task order together. After requested changes are incorporated, approve the final design and plan before execution. Recommended execution is inline in this chat using the executing-plans workflow; no subagents are assumed or authorized by this draft.
