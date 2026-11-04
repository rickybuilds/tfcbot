# Match deletion prediction cleanup implementation plan

**Goal:** Atomically delete a match while refunding unresolved wagers, retaining completed payouts and auditing the administrator and Elo result.

**Architecture:** Use the existing shared SQLite connection and immediate transaction for deletion, Elo and prediction operations. Preserve append-only prediction transactions, add a durable deletion audit/tombstone, and queue card changes only after commit. Existing owner financial permissions remain unchanged.

**Tech stack:** Node.js, better-sqlite3, node:test.

1. Reproduce settled-history rejection and swallowed Elo failures with regression tests.
2. Process every market with existing void logic; preserve and authorize settled history. Record match, actor, reason, states, refunds and Elo outcome transactionally; prevent deleted IDs from being reused.
3. Exercise normal and failure paths, multiple markets, duplicate attempts, reconciliation, permissions and competing writes. Verify Discord refresh behavior and accounting.
4. Document the command, run relevant and full tests from an isolated working directory, inspect the diff, then commit and push the requested branch.
