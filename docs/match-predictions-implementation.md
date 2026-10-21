# Match predictions implementation notes

Implementation remains isolated on codex/match-predictions and disabled by default. No deployment, merge or production-data mutation was performed. See [operating instructions](match-predictions.md).

## Decisions and practical limits

- Use Node/PowerShell equivalents for the POSIX workflow scripts on this Windows host. This changes no product behavior.
- Preserve the original drafts and other checkout changes. Existing ignored local tests were copied into the worktree for baseline verification; new prediction tests and the affected offense regression are explicitly tracked. Other local-only tests remain local.
- House-funded positive-difference corrections implement the user's final approval and replace every earlier debt/reversal proposal. Prior credits stay with recipients; the cost is explicitly audited new house issuance.
- Four financial tables plus one small metadata table store the feature in the configured ELO database. The additional metadata table holds schema version and persistent pause only.
- Freeze uncertain unfinished markets on restart while retaining their original deadline. Expired known deadlines close first. This may require an owner refund rather than inventing a missed all-eight time.
- Require a complete, recent, unambiguous chain of server logs from a persisted selected-map/log anchor before authorizing pregame reopening. Missing anchors or continuity yield unknown phase; the cost is owner intervention until monitoring is verified. No new server plugin was added.
- Count the official eight on the assigned server even if it is still on a lobby map. The existing bot does not automatically load the voted map at finalization; adding that map requirement would prevent normal countdowns.
- Add explicit owner retain authorization for deleting settled matches while preserving all financial history. Unresolved stakes still require refunds first.
- Refuse identity merges affecting existing prediction accounts until there is a financial merge policy. Existing merge verification also rolls back merges with retained old-ID snapshot references. The cost is deferring those identity merges.
- Treat the reviewer's latest-revision-only audit finding as important, because an owner needs prior stakes/refunds to review match finances. Match audit now includes every revision; no review minors remain deferred.
- Use the existing pinned parser dependencies locally to satisfy its pre-existing build prerequisite. No product dependency manifests or lockfiles were changed.

## Independent review and fixes

A fresh reviewer examined the whole feature. The following regressions were reproduced first and then fixed:

1. An early result is durably frozen in the official-result transaction, so a crash cannot turn it into a valid settlement on restart.
2. Starting-order changes reread the latest roster after phase verification, preventing a concurrent substitution from being undone in prediction snapshots.
3. Accepted armed-match state is updated before fallible Discord work; missing cards retain their destination for retry.
4. RCON reconciliation preserves connection session IDs, old connections cannot resurrect departed sessions, and all-eight candidates are confirmed authoritatively before a deadline is persisted.
5. Same-map halftime reloads retain earlier competitive-start evidence across the match's anchored log chain.
6. Owner match audits include all revisions and their refunded stakes.
7. Repeated pregame resets carry the log anchor forward when map/server terms are unchanged.
8. Slow RCON presence queries run independently of match arming. Substitution eligibility is rechecked after phase-query awaits.

Current-server signal delivery, actual raw RCON output and multi-user staging were not judged as verified: credentials are unavailable here. These remain explicit rollout gates. The original suspicion that voice tests leaked a process was corrected: they contain CPU-heavy 35-minute simulations that eventually pass.

## Verification

The final full suite passed 205/205 tests, including 45/45 prediction tests, with zero failures or skips. The existing parser was built successfully first. The suite ran with `node --test --test-force-exit --test-concurrency=1 "test/*.test.js"`, the existing local dependency path, and a loopback-only server fixture (`TFC_RCON_EAST_HOST=127.0.0.1`). JavaScript syntax and whitespace checks also passed. No test run starts the Discord bot or operates on a production database. Prediction tests use in-memory/temporary SQLite files; backup checks include committed WAL data, escrow, original deadlines and settlement retry safety.

## October 21 server diagnostics

The user's East-server RCON sample parsed successfully: two status rows (HLTV plus one authenticated player) correctly produce one eligible Steam identity. This sample does not establish the cause of an earlier failed reconciliation or verify a complete eight-player countdown. Added regression coverage for that response shape and fixed-category reconciliation warnings distinguishing incomplete status, timeout and connection refusal without exposing raw response data or credentials. Unknown errors retain a generic label. No lifecycle or payout behavior changed: a successful later query cannot reopen a market frozen by monitoring failure. The updated prediction suite passed 47/47 tests; syntax and whitespace checks passed. The full-suite result above predates this diagnostic-only update.

## October 21 restart handling

The next server test reported an incomplete roster around an in-game `!rs`. The confirmed lifecycle defect was that one failed query immediately and permanently froze predictions; the exact incomplete UDP response was not captured. Reproduced that behavior with a failing regression, then added a three-attempt limit with two-second retry gaps. Persistent failures still require owner review; successful retries never reopen already reviewed games or extend deadlines.

The user clarified that all eight arriving must still start the full 120-second betting countdown. An authorized restart request now invalidates pending roster replies and defers new roster queries until 15 seconds after sending the map command. Scheduled checks then run at restart +2 minutes and every minute afterward. Connection events may prompt earlier confirmation after the initial delay. Initial finalization checks and ordinary 15-second polling remain for matches without `!rs`. This does not change the existing game-server reservation or interpret map loading as competitive start. Player-facing My Bet now says "You have no bet on this game."

Regression coverage includes transient and persistent failures, map events invalidating queries, the 15-second/2-minute/1-minute schedule, connections triggering an earlier check, wrong-server/wrong-match requests, and a deadline expiring during retry. Existing frozen test matches must still be privately voided/refunded before using a new pickup. These changes require another server test; fixture tests do not prove the live restart timing or packet delivery.

Final verification after these changes: 215/215 full-suite tests passed, including 55 prediction tests, with zero failures or skips. The first run identified a new fixture reusing departed connection session IDs; it was corrected to represent new sessions, preserving stale-connect rejection. JavaScript syntax and whitespace checks passed. The concurrent remote map-pool update was fast-forwarded and preserved; the updated pool parses successfully. No live server commands, production data changes, deployment or merge into main were performed by the agent.

## October 21 unresolved games and progressive limits

The user approved an owner-only private `!pred unresolved` list and starting each person's maximum at 100 points, adding 10 per distinct settled game bet on without a fixed upper cap. Store enforcement and private controls now derive that limit from retained settled bets. Initial grants, player rewards, edits, cancellations, voids and pregame refunds do not earn progress; duplicate reports and corrections cannot earn it twice. All settled outcomes count. Previously earned progress remains through later result review. Existing rule-version-1 games, including replacement revisions, retain their earlier 250-point maximum; newly created games use rule version 2.

Prediction schema version 2 transactionally replaces only the old bet-table constraint and adds a progression index. It preserves existing bet IDs, point balances, append-only transaction rows and unrelated ELO data/global SQLite user version. Failed upgrades roll back. Amounts and total stakes retain safe-integer checks. Back up the configured database before updating; no production database was opened or upgraded during development.

The unresolved list includes every open, countdown, closed/awaiting-result and review-required game, even with new predictions disabled. It shows IDs, server, revision, locked points, deadline and review reason privately; long lists use an attachment, and blocked DMs never cause public disclosure. Reading it does not grant points or write ledger entries.

A [website implementation prompt](prompts/prediction-standings-website.md) is prepared. It requests an approved public ranking/privacy policy, a private signed-in account page, read-only integration with the authoritative data and correct treatment of grants, rewards, revisions and corrections. No website was built and no private standings were published.

Verification: 223/223 full-suite tests passed, including 63 prediction tests, with zero failures or skips. Additional assertions for losing bets and player-only rewards passed in the focused progression suite. Coverage includes limits exceeding 250, insufficient balances, duplicate/corrected reports, void/cancel farming, legacy-game rules, schema upgrade data preservation/rollback, owner-only lists and private delivery. Syntax and whitespace checks passed. Existing payout/correction fixtures were adjusted to the new initial 100-point limit without changing their accounting assertions.

A fresh read-only review of the follow-up reported no Critical, Important or Minor findings and independently passed all 15 progression/admin/interaction tests. Live Discord delivery, production upgrade execution and unchanged RCON/countdown integration remain operational checks; website implementation/publication and arbitrary database corruption were outside that review. No reviewer changed files or Git state.
