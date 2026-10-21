# Prompt: NoNamePickups prediction standings website

Use this prompt in the website repository. It is a brief for future work, not authorization to deploy or publish private financial data.

---

Build a prediction standings section for the existing NoNamePickups website. These are fictional bot points, separate from ELO. Begin by reviewing repository instructions, the existing website's architecture and authentication, and the bot's actual prediction schema and rules. Present the proposed design and integration plan for approval before implementing.

The bot repository is `C:\Projects\tfcbot`, with prediction work on `codex/match-predictions` and PR https://github.com/rickybuilds/tfcbot/pull/3. The existing website repository may be `C:\Projects\nonamepickup-web`; verify the intended repository before editing it. Use the current approved bot implementation, not an assumed copy of main. Read `docs/match-predictions.md`, `docs/match-predictions-implementation.md` and `predictions/{schema,store,payouts}.js` in that checkout. Keep website changes isolated in an appropriate feature branch. Do not modify the bot's live database, merge, or deploy without explicit authorization.

## First resolve privacy and ranking

The original rules keep individual picks, stakes, balances and payouts private. A public standings page changes what people can infer. Ask the owner to approve the public fields, opt-in policy and ranking metric before exposing data. An opt-in leaderboard is a proposed starting point, not an approved policy. Until approved, use clearly marked mock data for public previews and keep real financial information private.

Propose a clear ranking metric and explain its tradeoffs: total points represents wealth including player rewards and grants; net betting profit represents betting results. Do not silently treat every credit as betting profit. Decide whether opt-in users publish balance, net profit, win rate or only an approved score/rank. Define ties, minimum sample size and inclusion of inactive users. Never publish another person's individual picks or stakes, including through API responses or downloadable data, without a separate explicit decision.

## Proposed initial experience

- A mobile-friendly standings table with approved display names, rank and metrics, sorting, last-updated time and useful empty/loading/error states. Reuse the site's existing visual style and stack.
- An authenticated "My Predictions" page showing the signed-in person's own balance, points locked in bets, applicable personal limit, settled-game count and private history. Identify them from the authenticated Discord session, not a user-supplied Discord ID.
- A short rules page explaining private Discord betting, eligibility, the full two-minute closing window and point distribution. Keep wagering in Discord for the first website version; the website displays standings and private account information.
- Clear distinctions between betting returns, official-player rewards, initial grants, owner adjustments, refunds and house-funded corrections. Show pending/reviewed results honestly.

## Rules to preserve

- Once-only 1,000-point initial grant. Website reads must not create an account or grant points. An account that has not been initialized should be represented as such rather than inventing a stored balance.
- For new rule-version-2 games, personal maximum is `100 + 10 × distinct settled games bet on`, with no fixed business cap. It is also constrained by available points and safe-integer representation. Wins, losses, ties and settled no-correct-bettor refunds all count. Edits, cancellations, voids, pregame refunds and player rewards do not count. Corrections and duplicate reports never count the same game twice. Previously earned progression remains during later result review. Prior settled version-1 bets count toward progress.
- Existing rule-version-1 games retain their fixed 250-point limit, including replacement revisions. Display the applicable per-game limit separately from the current personal progression limit when they differ. Read the bot's rule version and calculation; do not duplicate a conflicting formula in browser code.
- Original Blue/Team 1 and Red/Team 2 identities stay fixed across halftime colors. The official eight, offense and former participants cannot bet; only the official eight receive player rewards.
- All eight confirmed on the assigned game server starts a full 120-second betting window. `!rs` only schedules/defer roster checks. Website status and deadlines must come from the bot's persisted state, never from browser guesses about map loading or gameplay.
- Correct stakes return first; remaining pot is 70% correct bettors / 25% winning players / 5% losing players. Ties use 90% correct bettors / 10% official players. No correct bettors means refund all stakes with no player rewards.
- Owner corrections preserve every previous credit and pay only positive differences, funded by the house. Never reverse balances or count successive correction credits twice. A corrected win/loss metric and actual historical credits can differ; label and define those metrics explicitly.

## Data integration and financial correctness

Use the existing configured ELO database as the authoritative prediction source. Prediction data is in separate tables inside it; database consolidation is out of scope. Design a read-only server-side integration suited to the actual hosting layout. If the site and bot run separately, propose a narrowly scoped authenticated API or consistent approved export; do not expose the database file, SQLite credentials, Discord tokens or RCON/SSH settings to browsers. Avoid unreliable copies of a live SQLite file or its WAL. Browser requests must never perform financial writes.

Use retained transaction history and distinct settled bets to derive approved metrics. Do not sum all ledger rows as income: operation markers, allocation snapshots and previews are not money movement. Prevent joins from multiplying a stake or payout across revisions and correction versions. For betting profit, exclude the initial grant, owner adjustments, player-only rewards and pregame/void/cancel refunds. Define how actual retained house-funded correction credits appear. Keep unsettled and review-required performance figures separate from finalized figures. Corrected results, retained match history after deletion and no-correct-bettor settlements need explicit treatment.

Return only approved fields from public APIs. Enforce private account access on the backend; hiding columns in the UI is insufficient. Avoid private data in logs, page source, public caches, errors, analytics and static exports. Private responses must not enter shared caches. Reuse existing authentication and secret handling. No new owner financial controls on the website in this first version.

## Validation and delivery

Test metric calculations against real schema-shaped fixtures covering grants, wins/losses/ties, player rewards, cancelled/voided bets, replacement revisions, duplicate reports, multiple corrections and previously spent payouts. Test limits starting at 100 and exceeding 250, and legacy-game limits. Verify permissions with two different Discord accounts and anonymous access, pagination/tied ranks, empty data, unavailable backend and stale data. Use temporary databases or approved fixtures, not production mutations.

Deliver a reviewed data contract and metric definitions, the implementation in the isolated website branch, meaningful tests, screenshots of desktop/mobile states, setup documentation and a pull request. Report which server integrations remain unverified. Publishing standings, changing privacy defaults, merging and deploying require separate approval.
