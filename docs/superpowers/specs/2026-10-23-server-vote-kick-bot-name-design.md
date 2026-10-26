# Server-vote kick bot-name refresh

## Intent

When a player is kicked because they missed the server vote, the bot nickname must immediately leave `NoNamePUG (Voting in Progress)` and show the current queue count, such as `NoNamePUG (7/8)`.

## Scope

- Add regression coverage for the low-level `startVote` server-vote timeout path that removes missing voters and exits early.
- Refresh the bot nickname after that path clears `state.isVotingInProgress`.
- Keep the existing queue-board refresh and kick behavior unchanged.

## Approaches

- Recommended: refresh in `lib/vote.js`, where the shared early-return path owns the state transition. This covers all callers of `startVote`.
- Alternative: add a caller callback and make each vote-flow caller refresh its own nickname. This distributes cleanup responsibility and is easier to regress.

## Constraints and verification

Use the existing Node test suite and Discord test doubles. The regression test must fail before the production change, then pass after it. Run the focused test and the full `npm test` suite.
