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
