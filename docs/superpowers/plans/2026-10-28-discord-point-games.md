# Discord Point Games Implementation Plan

**Goal:** Add casino roulette, coin flips and opt-in duels using the prediction point bank.
**Architecture:** Atomic SQLite operations reuse the existing immutable ledger and account checks. Roulette cooldowns and pending duels persist in SQLite. Discord commands publish the game results and use message IDs for replay safety.
**Tech Stack:** Node.js, discord.js, better-sqlite3, node:test.

- [ ] Test and implement game accounting, roulette payouts and per-server cooldown, and opt-in duel acceptance and expiry.
- [ ] Test and integrate Discord commands and configuration, and document rules.
- [ ] Run focused and full bot tests and review the changes.
