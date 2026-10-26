# `!last @user` History Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `!last @user` exclude completed roster-only matches and match the website's player history.

**Architecture:** Keep the command local and preserve its public helper interface. Change only the player-history SQL predicate to require a player-specific `rating_changes` row; leave result/MVP formatting unchanged.

**Tech Stack:** Node.js, better-sqlite3, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-26-last-player-history-design.md`

## Global Constraints

- Do not change website APIs, Elo calculations, match reporting, or all-player `!lastmatches` output.
- Do not add an HTTP dependency.
- Preserve existing output and profile link behavior.

## Review Focus

- A completed match containing the player in roster JSON but lacking that player's rating change must be excluded — regression test in `test/matches.test.js`.
- A completed match with a matching rating change must remain included — same test.
- Team/result calculation must still use roster JSON — existing helper assertions plus the new query test.
- Existing databases without MVP tables must retain fallback behavior — existing catch path remains unchanged.

### Task 1: Anchor player history to rating changes

**Files:**
- Modify: `commands/matches.js:155-169`
- Test: `test/matches.test.js`

**Interfaces:**
- Consumes: `getPlayerLastGames(database, playerId)` and existing `matches`/`rating_changes` schema.
- Produces: the same array shape, containing only completed matches with a matching player rating-change row.

- [ ] Write a failing test that creates one valid completed match with a rating-change row and one newer roster-only completed match, then asserts only the valid match is returned.
- [ ] Run `node --test test/matches.test.js` and confirm the test fails because the roster-only match is currently returned.
- [ ] Add an `EXISTS` predicate to the player-history query requiring `rating_changes.player_id = ?` and `rating_changes.match_id = matches.match_id`; bind the player ID without changing the existing roster parameters.
- [ ] Run `node --test test/matches.test.js` and confirm it passes.
- [ ] Run `npm test` and confirm the full suite passes.
- [ ] Commit the implementation, regression test, spec, and plan.
