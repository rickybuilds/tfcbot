# Match Predictions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a draft for user review; do not execute before approval.

**Goal:** Add private pickup predictions with auditable points, durable betting deadlines, and safe refunds and settlement inside the existing ELO SQLite database.

**Architecture:** Separate storage, payout calculation, lifecycle/presence, and Discord interactions under `predictions/`. Existing match commands call narrow lifecycle hooks; all point mutations use the shared `elo.db` handle and short synchronous transactions. No new external database or package is planned.

**Tech Stack:** Node.js CommonJS, discord.js 14, better-sqlite3, existing HLDS/RCON integrations, Node test runner.

**Spec:** [Revised match predictions design](../specs/2026-10-20-match-predictions-design.md). Approved for isolated implementation after final policy confirmation. House-funded corrections supersede every earlier reversal/debt proposal.

## Global constraints

- All prediction tables live in the existing configured `elo.db`; ELO and points remain separate.
- One-time starting grant: 1,000. Stake: whole number 1–250. One active pick per person per market revision.
- Countdown: 120,000 milliseconds after all eight official linked roster players are present on the assigned server. No fixed ten-minute window.
- Competitive play during that window is permitted. A competitive-start event never shortens the two-minute deadline, and disconnects/restarts never extend an existing deadline.
- Return correct stakes first. Remaining pot: 70% bettors / 25% winning players / 5% losing players; ties: 90% bettors / 10% official players.
- Approved: no correct bettors refund all stakes with no player payouts; house-funded corrections never claw back credits or create debt; only the official eight receive player shares; former participants remain excluded. Integer allocations conserve the complete pot.
- All picks/amounts/balances are private except authorized owner audit access.
- Owner-only financial actions; reason, preview, confirmation, and idempotency required.
- No monthly bonuses, ELO-priced odds, leaderboards, website work, 1v1 predictions, or database migration in V1.
- Implement the approved revised spec/plan. Implementation is isolated, disabled by default and tested with temporary databases. No deployment, production data changes, merge or enablement is authorized.

## Review focus

1. A stale modal or simultaneous click must not bypass closure, a roster revision, or balance limits (Tasks 2, 4, 5).
2. A player already connected before finalization, duplicate events, or a second server must not corrupt the eight-player condition (Tasks 1, 3).
3. Bot downtime or lost monitoring must not restart or extend a countdown; permitted gameplay within the original window must not trigger premature closure or false review (Tasks 1, 3, 7).
4. Sub/shuffle/map/starting-order changes, match deletion, and forced historical edits must not lose stakes or silently alter payout recipients (Tasks 5, 6).
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
- `config.js`: feature enable flag and explicit owner ID; defer optional audit channel.
- `services/rconClient.js`: separate raw status interface; keep existing formatted status behavior.
- `services/hldsLogs.js` and `services/autoRecap.js`: verified live-start hook only where supported by discovery.
- `commands/voteFlow.js`: persist final match before market creation/message attachment.
- `commands/sub.js`, `commands/shuffle.js`: final roster mutation/refund transaction and updated card.
- `commands/setmap.js`, `commands/settings.js`, `services/autoRecap.js`: apply the same terms-change policy to map and armed-match starting-order edits; preserve logical team identities at halftime.
- `commands/admin.js`: common report/fixreport and deletion integration.
- `commands/purgematches.js`, `lib/matchStore.js`, `lib/elo.js`: guarded deletion entry points where they can remove relevant matches; do not change ELO math.
- `commands/help.js`, `README.md`: brief player/owner documentation.
- `index.js` backup scheduling: include the configured ELO database path rather than the literal default `elo.db`.
- `tools/mergeDiscordAccount.js`: refuse identity merges affecting prediction records pending a separately defined account-merge policy; preserve financial history and once-only grants.
- Existing backup and match-flow tests only where behavior changes.

## Public interfaces

Use strings for Discord IDs/match IDs, safe integer milliseconds for timestamps, and safe integer points. `MarketRef` is `{ marketId: number, revision: number }`. `RosterSnapshot` contains `{ matchId, blueIds, redIds, offenseIds, steamIdsByDiscordId, serverKey, mapName, team1Starts }`. `OperationContext` contains `{ operationKey, actorId, reason?, now }`.

Factory: `createPredictions({ db, client, config, resolveSteamIds, queryServerRoster, clock, logger })` returns the facade below. Inject clock/network adapters for tests.

- `initialize()` applies schema and performs recovery; unresolved recovery cannot expose open mutations.
- `onMatchFinalized(snapshot, context)` returns current/new market, or no market if disabled/unsupported.
- `applyRosterChange({ matchId, nextSnapshot, applyMatchWrites, context })` synchronously runs final match writes plus financial invalidation in one DB transaction. `applyMatchWrites` must contain no network calls or nested transaction ownership.
- Use `applyRosterChange` for every effective terms change, including map/starting order. Final snapshots are computed and validated before this call; memory/player-lock updates follow commit. Unknown phase cannot authorize a replacement market.
- `onHldsEvent(event)` updates presence and accepts verified live-start evidence.
- `reconcileServer(serverKey)` fetches and reconciles authoritative presence; failures trigger monitoring safety rules.
- `observeOfficialResult({ matchId, outcome, context })` synchronously records result observation/review invalidation inside the transaction persisting the official result. It performs no network calls and invalidates pending correction previews when the result changes.
- `onMatchReported({ matchId, result, now })` reads persisted official result/observation and settles or requests review idempotently; recovery calls the same method. Result observation remains durable even if ELO scheduling or Discord work fails before this call.
- `assertCanDeleteMatch(matchId)` refuses deletion of unresolved financial/history dependencies unless owner-resolution policy permits retaining the market snapshot.
- `applyMatchDeletion({ matchId, applyMatchWrites, context })` refunds unresolved stakes and performs allowed match deletion atomically while retaining ledger records.
- `handleInteraction(interaction)` returns whether it handled the prediction namespace.
- `handleAdminCommand(message, args)` handles `!pred` with owner authorization.
- `stop()` releases listeners/timers without resetting persisted markets.

## Task 1: Prove server presence and live-start inputs

**Files:** `predictions/presence.js`, `services/rconClient.js`, relevant HLDS/auto-recap adapter, `test/predictionPresence.test.js`, operational docs.

**Consumes:** existing normalized server keys, Steam links, trusted HLDS events. **Produces:** `queryServerRoster(serverKey) -> Promise<{ serverKey, mapName, steamIds, observedAt, complete }>` and tested phase event contract `{ type: 'prediction_live_start', serverKey, sourceKey, logInstance, sourceTs, receivedAt }`. The service associates evidence with a single current match from its saved context; raw server events do not magically contain a match ID. Phase evidence never shortens a betting deadline.

- [ ] Use the four bundled real logs and upstream `PrematchEnd` parser as evidence for `World triggered "Match_Begins_Now"`. Verify current server/mode delivery and reconnect evidence read-only if credentials are available. Record unavailable access explicitly; do not invent current-server verification or block unrelated disabled-feature implementation on deployment access. Capture a real raw status fixture before rollout; synthetic fixtures test parsing but are not operational proof.
- [ ] Write failing tests: eight distinct linked roster players match; extra spectators/offense/unrelated server/multiple Steam IDs do not inflate the count; an official roster player spectating counts as connected; missing or overlapping identity links do not falsely trigger eight; pending authentication resolves through status; players already present are found; malformed/truncated RCON fails reconciliation; stale responses/disconnects cannot replace newer sessions; warmup and halftime do not generate a first live-start. Replay each bundled start line through the live parser and assert normalized phase evidence, without emitting a betting-close action.
- [ ] Run `node --test test/predictionPresence.test.js`; expect the new assertions to fail before implementation.
- [ ] Implement raw status and normalized presence adapters without changing existing formatted RCON responses. Document the proven live-start evidence and the monitoring-gap policy.
- [ ] Run the same test file; require all tests pass. Document separate source/receipt timestamps, per-server monitoring health and recovery evidence. If phase cannot be established, forbid automatic reopening on a terms change; keep rollout disabled pending current-server validation. Any new server plugin requires separately reviewed scope.
- [ ] Commit this task after implementation approval.

## Task 2: Build auditable accounts, escrow, and payout allocation

**Files:** `predictions/schema.js`, `predictions/store.js`, `predictions/payouts.js`; schema/store/payout tests.

**Consumes:** spec constants and roster snapshots. **Produces:** `PredictionStore(db)`, `ensureAccount(discordId, context)`, `placeBet({ marketRef, discordId, pick, stake, context })`, `cancelBet({ marketRef, discordId, context })`, `voidMarket({ marketId, context })`, `settleMarket({ marketId, outcome, context })`, `correctSettlement({ marketId, outcome, context })`; `calculatePayouts({ bets, outcome, blueIds, redIds }) -> { credits, pools, totalStaked }`. Mutators return persisted operation results and typed validation failures.

- [ ] Write failing schema/store tests for idempotent migrations, exactly-once grants, participant exclusion across revisions, safe-integer validation, cap/edit/refund behavior, concurrent cross-match spending, duplicate operation replay and account/ledger agreement. Use temporary databases and two handles for contention tests.
- [ ] Write payout tests for decisive/tie outcomes, 1,000/400 example, unequal stakes, one-point remainder ties, no bets, all correct, no correct bettors, and conservation across generated stake combinations. A correct bettor's returned stake is distinct from profit.
- [ ] Add settlement/correction tests proving duplicate settlements from different command IDs are no-ops; positive-difference top-ups retain prior credits; original stakes are not debited twice; spent and unspent credits are protected; successive corrected results cannot repeat credits; all house issuance is audited; injected failures roll back completely. Cover corrections to/from no-correct-bettor refunds and zero-value operations.
- [ ] Run `node --test test/predictionSchema.test.js test/predictionPayouts.test.js test/predictionStore.test.js`; expect new tests to fail first.
- [ ] Implement additive migrations, minimal indexes, append-only ledger and pure largest-remainder math. All financial methods share the injected synchronous SQLite transaction; use guarded writes, unique operation/entry keys and settlement-version uniqueness. Keep original locked inputs and complete prior allocations in append-only version metadata, including zero-value operations. A no-correct-bettor refund is a correctable settlement, distinct from a terminal void.
- [ ] Run the same test files; require pass and assert the escrow/account/grant invariant after each scenario.
- [ ] Commit this task.

## Task 3: Implement durable market lifecycle and recovery

**Files:** `predictions/service.js`, `predictions/index.js`, `test/predictionService.test.js`.

**Consumes:** Tasks 1–2. **Produces:** facade lifecycle methods, stored market revisions/deadlines, recoverable settlement queue through market state queries (no extra queue database).

- [ ] Write failing fake-clock tests for finalization, all-eight-already-present, exactly 120 seconds, duplicate events, disconnects without deadline extension, deadline checks despite timer delay, wrong-map/server rejection, monitoring outage/review state, and independent matches on different servers. A verified start at countdown +30 seconds must leave betting open at +119999ms and reject placement/edit/cancel at +120000ms. A start before all-eight confirmation must not create an early-close deadline. Phase cannot revert at halftime.
- [ ] Add restart tests: expired countdown closes immediately; unexpired countdown keeps original deadline; no restored market accepts bets until reconciled; a missed all-eight trigger or uncertain material change enters review; a completed persisted result settles exactly once after a crash. Known gameplay inside the original stored window is allowed, not a review trigger. Presence reconciliation must not reset a stored deadline or claim to reconstruct an unknown historical trigger. Existing historical matches never get new markets; recovery works without AutoRecap memory.
- [ ] Run `node --test test/predictionService.test.js`; confirm failures.
- [ ] Implement state transitions and a 15-second reconciliation loop for open/countdown markets. Persist before scheduling. Keep network I/O outside SQLite transactions; deduplicate active server polling. Capture immutable rule/identity/starting-order snapshots. Settlement requires the approved deadline and valid terms, not closure before gameplay.
- [ ] Run the same test file; require pass.
- [ ] Commit this task.

## Task 4: Implement private Discord betting interactions

**Files:** `predictions/interactions.js`, `predictions/messages.js`, `test/predictionInteractions.test.js`.

**Consumes:** store/service and `MarketRef`. **Produces:** shared action row builder, persistent `pred:` button/modal dispatcher, private My Bet/change/cancel views.

- [ ] Write failing tests for Blue/Red/Tie amount modal, default 100/existing stake, private confirmation, My Bet without a bet, change/cancel, participant rejection, insufficient funds, signed/decimal/oversized input rejection, stale revisions, forged identifiers, duplicate interaction delivery, disabled outcome buttons with working My Bet, and delayed modal submission at deadline.
- [ ] Add privacy tests proving public card/settlement output never includes individual stakes, picks, balances, payout details, or outcome-specific pot totals. Show only status/deadline/official outcome publicly; no optional audit channel in V1. Simulate Discord response failure after commit and verify retry does not debit twice.
- [ ] Run `node --test test/predictionInteractions.test.js`; confirm failures.
- [ ] Implement persistent routing rather than process-local collectors for public betting controls. Revalidate state at submission; use interaction ID operation keys. Use existing discord.js dependency and current project's private-response conventions.
- [ ] Run the same test file; require pass.
- [ ] Commit this task.

## Task 5: Wire match creation, roster changes, and event routing

**Files:** `index.js`, `config.js`, `commands/voteFlow.js`, `commands/sub.js`, `commands/shuffle.js`, `commands/setmap.js`, `commands/settings.js`, relevant HLDS/AutoRecap adapter; integration tests.

**Consumes:** public facade and shared message builder. **Produces:** predictions for new supported matches and atomic pregame invalidation on final roster changes.

- [ ] Write failing integration tests for successful finalization only after DB persistence, failed persistence without a market, duplicate finalization without resets, one prediction message binding, standard rebalance and captain-preserving sub, shuffle, offense participant changes, and rejected/no-op commands without refunds. Validate final roster uniqueness before writes. Test `!setmap` and armed starting-order changes, including no-op/default-only changes. Verify both swapped and unchanged second-half physical colors preserve the original bet outcome and recipients.
- [ ] Test a bettor becoming the substitute, former participants attempting to bet, fresh countdown with eight already present, midgame sub voiding without reopening even inside the initial two-minute window, and an old card/modal used after the update. Test an uncertain phase change freezing for review without reopening. Inject failure between final roster write and market reset; every roster/offense/scenario write must roll back and memory/player locks must remain unchanged.
- [ ] Test that prediction events are routed before unrelated queue/duel handlers can consume relevant disconnects, while server/match validation still rejects unrelated events. Normal 1v1 behavior stays unchanged.
- [ ] Run `node --test test/predictionIntegration.test.js`; confirm failures.
- [ ] Wire factory/config/dependencies and a persistent interaction listener. Reorder finalization so saved match/market precedes public betting controls; persistence failure must not continue into a successful market/card. Compute substitution final teams before any mutation; commit roster/offense/scenario changes and market invalidation together, then update memory/player locks. Route map/starting-order mutations through the same boundary and persist their accepted context. Leave Discord/RCON work outside transactions. Bind updated cards and reject previous revisions.
- [ ] Run prediction integration and existing sub/shuffle/captain/queue tests selected from the repository; require pass.
- [ ] Commit this task.

## Task 6: Integrate settlement, owner corrections, and deletion safeguards

**Files:** `predictions/admin.js`, owner-confirmation routing, `commands/admin.js`, `commands/purgematches.js`, relevant deletion entry points, admin/integration tests.

**Consumes:** persisted official results, store reversal methods, lifecycle facade. **Produces:** common report settlement hook, private owner command suite, safe deletion/purge behavior.

- [ ] Write failing tests covering manual/automatic identical results, changed ordinary report as well as fixreport requiring review, Gentle ELO delay without prediction delay, and startup settlement retry after a saved result. A report before the two-minute deadline must freeze for review rather than silently shortening the window. Inject failures after official result persistence, during ELO scheduling and before Discord acknowledgement; result observation/review invalidation must already be durable. Different report interaction IDs cannot cause duplicate payouts.
- [ ] Add owner tests: admin role alone refused; missing owner configuration refused; owner-bound preview expires after 60 seconds; replayed confirmation is idempotent; changed versions invalidate preview; required reason; private delivery failure does not post publicly. Cover status/void/correct/adjust/audit/pause/resume and reject correction outcomes inconsistent with the official match. Defer individual owner refunds and manual early-close controls; whole-market void handles exceptional refunds.
- [ ] Add deletion tests for refunding unresolved stakes transactionally, refusing unresolved settled-history edits, blocking bulk purge with dependent markets, and retaining financial rows after permitted deletion. Forced completed sub must require owner financial review rather than silently changing recipients.
- [ ] Run `node --test test/predictionAdmin.test.js test/predictionIntegration.test.js`; confirm new tests fail.
- [ ] Implement synchronous `observeOfficialResult` in the official-result transaction before any fallible asynchronous/report follow-up, then call retryable settlement. Implement startup retry, house-funded correction top-ups, and strict owner administration. Inventory all `DELETE FROM matches` entry points before adding shared guards, including the separate `MatchStore` connection. Ensure denial happens before ELO unreport or memory clearing. Keep original ELO authorization separate from point correction authorization and do not broaden scope into a general ELO-report refactor.
- [ ] Run the same test files plus existing report/deletion tests; require pass.
- [ ] Commit this task.

## Task 7: Verify recovery, backups, privacy, and controlled rollout

**Files:** `docs/match-predictions.md`, `README.md`, `commands/help.js`, focused integration/backup tests.

**Consumes:** completed subsystem. **Produces:** verified operating instructions and a disabled-by-default release ready for explicit rollout.

- [ ] Add recovery tests for process interruption after debit, deadline persistence, saved result before settlement, and correction commit before Discord acknowledgement. Verify feature disabled and persistent pause do not strand refunds/settlements.
- [ ] Add a backup/restore test using the existing SQLite-aware backup path: restore accounts, escrow, market revisions and ledger; reconcile totals and verify no initial grants or settlements repeat. Update `scheduleBackups` wiring to pass the resolved `DB_PATH` / `ELO_DB` path plus existing non-database backup sources. Test an alternate configured path and committed WAL contents without opening production data.
- [ ] Run `node --test test/prediction*.test.js` and `npm test`; require pass. Record any pre-existing failures separately rather than claiming a clean suite.
- [ ] Review the final diff for raw bet logging, root/admin permission shortcuts, direct point-balance edits outside store transactions, unguarded match deletion, and timers that reopen markets on restart.
- [ ] Document setup, exact rules, owner commands, live-start evidence, monitoring outage recovery, house-funded correction handling, and rollback with outstanding stakes. Add concise help and README links.
- [ ] Before rollout, on a staging copy exercise a complete match, tie, pregame sub/shuffle/map/starting-order change, live sub, owner correction, bot restart during countdown, and loss of HLDS/RCON monitoring. Verify private responses with separate Discord users, current start-event delivery and unchanged ELO outcomes. Record unavailable credentials/server access as unverified rollout gates; never claim these operational checks passed from unit tests alone.
- [ ] Keep `PREDICTIONS_ENABLED=0` until the live-start signal and staging checklist pass and the user authorizes rollout. Enable only new matches; do not create historical markets.
- [ ] Commit documentation/verification changes and report results for final review.

## Review and execution handoff

Approved by the user after clarification of player eligibility, refund/reset policy, no-correct-bettor refunds and house-funded corrections. Execute inline using executing-plans and TDD on codex/match-predictions. Keep the feature disabled by default. Deployment, merge, production data mutation and enablement remain outside authorization. Current-server verification and staging are rollout gates; unavailable credentials do not prevent isolated implementation.
