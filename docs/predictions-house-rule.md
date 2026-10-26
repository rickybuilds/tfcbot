# No-correct-bettor house rule — October 26, 2026

The owner requested that losing bets remain losses even when nobody bets on the official winning outcome. Newly created games use rule version 3: if nobody picks Blue, Red or Tie correctly, the entire stake pool goes to the house, with no bettor or player rewards. A sole bettor who picks incorrectly loses their stake.

Record the full pool as a positive `house_collection` ledger entry without a user account. Stakes were already deducted when placed; settlement must not deduct them again. Accounting subtracts house collections from issued player points. Settlement, collection, allocation and bet finalization share the existing transaction. Duplicate settlement does not collect twice. Owner corrections retain prior credits and use the existing audited house-funding mechanism for additional entitlements.

Existing markets and replacement revisions retain their stored rule version, including the earlier no-correct-bettor refund rule. Past settlements and balances are not rewritten. Normal winning-pick payouts, progressive limits and void/cancellation refunds remain unchanged. Rule version 3 cards and My Bet explain the house rule. Zero reward pools are represented explicitly, so website accuracy counts these bets as losses rather than legacy refunds.

This uses the existing flexible ledger and rule-version fields; no schema migration, dealer Discord account or database rewrite is needed. Deploy the bot code and restart the bot to apply the rule to new games. Website code does not need changing.

The website's `prediction-rules.html` wording was also updated in the local website checkout; deploy that documentation alongside the bot change.

## Validation

All 183 prediction tests passed, including new house-take, duplicate settlement, owner correction, collection rollback and legacy/replacement refund regressions. Changed JavaScript syntax and both repositories' whitespace checks passed. Independent read-only review found no actionable issues.

The broader isolated bot run passed 355 of 359 checks. The four remaining checks were outside predictions:

- `parseNoNameLogs.test.js`: local logs import requires the parser to be built first.
- `rule8.test.js`: “Rule 8 command jails at five infractions and escalates by 24 hours” fails because the role-cache fixture does not support `.map()`.
- `rule8.test.js`: “Rule 8 clear refunds the latest Elo transfer and threshold jail” expects lowercase text but receives “Cleared”.
- `voicePcm.test.js`: stalled during loading; its test subprocess was stopped after approximately 34 seconds, despite the run's 15-second test timeout.

No production database, past balance, live message or server process was changed during implementation. Production deployment remains a separate step after publishing the code.
