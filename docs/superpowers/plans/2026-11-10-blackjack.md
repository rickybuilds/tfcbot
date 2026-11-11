# Shared Blackjack Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent 2–5 player blackjack table to the configured casino channel, with private seat wagers, public table controls, and correct point settlement.

**Architecture:** Add blackjack-specific persistence and game rules in the predictions game service, then expose them through the existing Discord command and interaction routers. The public table message reflects persisted state; ledger changes and idempotent state transitions remain authoritative across restarts.

**Tech Stack:** Node.js, discord.js v14, better-sqlite3, existing PredictionStore point ledger.

**Spec:** `docs/superpowers/specs/2026-11-10-blackjack-design.md`

## Global Constraints

- Use the configured casino channel only.
- A table has five seats and accepts 1–500 points per initial hand.
- The opening window is 60 seconds; only the player who opened the table can deal early (whether seated or not), and the timer auto-deals.
- Split adds a second wager up to 500, with total exposure at most 1,000 per player for the initial hand plus one split hand.
- Persist active state and account for all held blackjack stakes in bank/escrow accounting.
- No threads, extra channels, cash betting, or more than one active table per guild/channel.

## Review Focus

- Two users try to claim one seat concurrently — exactly one seat and one held stake; loser gets a clear ephemeral error.
- User has insufficient balance for join, double, or split — no partial state or ledger change.
- Join timer expires with zero or one-plus players — close empty table, deal populated table exactly once.
- Bot restarts during joining or player actions — persisted deadline/state resumes without duplicate cards or payouts.
- Duplicate interaction delivery or message edit failure — no duplicate wager, draw, or settlement.

---

### Task 1: Persistent blackjack state and ledger integration

**Files:**
- Modify: `predictions/schema.js`
- Modify: `predictions/store.js`
- Modify: `predictions/bank.js`
- Test: `test/blackjack.test.js`

**Interfaces:**
- Create tables for blackjack rounds, seats, and hands/cards/actions. Persist guild/channel/message IDs, state, deadline, shoe order/current position, dealer hand, player turns, and wager statuses.
- Include active blackjack wagers in held-bank reporting and `assertAccounting()` escrow totals.

- [ ] Write failing schema, held-balance, and escrow accounting tests for a seated player.
- [ ] Run `node --test test/blackjack.test.js` and confirm the new tests fail.
- [ ] Add schema migration and escrow/bank accounting support.
- [ ] Run the targeted test and confirm persisted held stakes balance against ledger/account totals.

### Task 2: Blackjack round and action rules

**Files:**
- Create: `predictions/blackjack.js`
- Modify: `predictions/games.js`
- Test: `test/blackjack.test.js`

**Interfaces:**
- `games.blackjackOpen({guildId,channelId,context}) -> round`
- `games.blackjackJoin({roundId,guildId,channelId,userId,seat,stake,context}) -> round`
- `games.blackjackDeal({roundId,guildId,channelId,userId,context}) -> round`
- `games.blackjackAction({roundId,guildId,channelId,userId,handId,action,stake?,context}) -> round`
- `games.blackjackStatus({guildId,channelId}) -> round | null`
- `games.blackjackExpire({roundId,expectedDeadline,context}) -> round`
- Keep all money movements and status transitions inside immediate DB transactions with operation keys.

- [ ] Add deterministic-shoe tests for scoring, ace valuation, natural blackjack, dealer stand-on-17, win/loss/push payouts, double, split, split aces, turn sequencing, and expiration.
- [ ] Run targeted tests and confirm they fail.
- [ ] Implement round creation, seat claiming with 1–500 stake validation, deal, actions, turn timeout, dealer resolution, and settlement.
- [ ] Run targeted tests and confirm the rules and point accounting pass.

### Task 3: Casino channel Discord table UI

**Files:**
- Create: `predictions/blackjackPanel.js`
- Modify: `predictions/gameCommands.js`
- Modify: `index.js` if interaction/timer registration needs service wiring
- Modify: `commands/help.js`
- Test: `test/blackjack.test.js`

**Interfaces:**
- `!blackjack` opens the persisted table message in `config.channels.casino`.
- Five seat buttons launch a private stake modal; successful seats become disabled in the updated shared message.
- Show remaining open time and a **Deal now** button when at least one player is seated.
- During play, show public cards, current actor, and only valid controls; actions are user-bound and unauthorized clicks get ephemeral feedback.
- Register timer callbacks and startup deadline recovery; disable controls on terminal rounds.

- [ ] Add command/modal/button tests for configured-channel restriction, seat modal limits, duplicate seating, early deal, empty timeout, populated timeout, player-only hand actions, and public message updates.
- [ ] Run targeted tests and confirm they fail.
- [ ] Implement the panel, component routing, timer recovery, and help entry.
- [ ] Run targeted tests and confirm the end-to-end table flow.

### Task 4: Full verification and review

**Files:**
- Test: `test/blackjack.test.js`
- Modify any implementation files required by failures.

- [x] Run `node --test test/blackjack.test.js`.
- [x] Run the complete project suite with `npm test` (see execution note below).
- [x] Review database recovery, interaction authorization, accounting invariant, and terminal component state against the design spec.

Execution note: the targeted blackjack suite passed. The parallel `npm test` run reported 343 passing and 6 failures. A serialized root test run reported 346 passing and the same 6 failures, all from `SQLITE_CORRUPT` / `invalid rootpage` for the unrelated `pickup_flag_carry_rounds` schema in existing Elo database tests. No blackjack test failed in either root test run.
