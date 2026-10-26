# `!last @user` History Selection Design

## Intent

Make `!last @user` agree with the website's recent-form history by selecting only completed matches that have a `rating_changes` row for that player. The current command selects any completed match containing the player in roster JSON, which can include stale roster-only records.

## Goals

- Exclude completed roster-only matches from a player's recent history.
- Preserve the existing result, MVP marker, output format, and profile link behavior.
- Add a regression test for the stale-roster case.

## Non-goals

- Do not change the website API, Elo calculations, match reporting, or all-player `!lastmatches` output.
- Do not make the bot depend on the website over HTTP.

## Approaches

- Call the website recent-history API: guarantees surface parity but adds network availability and response-shape coupling.
- Anchor the local query to `rating_changes`: matches the website's authoritative selection rule with a small local-only change. **Selected.**

## Constraints and implementation call

Keep the existing `getPlayerLastGames(database, playerId)` interface. Add an `EXISTS` condition requiring `rating_changes.player_id` and `rating_changes.match_id` to match the selected completed match, while retaining safe JSON roster membership checks for team/result calculation. The test will use an in-memory SQLite database with one valid match and one roster-only match.
