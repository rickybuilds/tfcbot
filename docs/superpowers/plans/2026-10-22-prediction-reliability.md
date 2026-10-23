# Prediction reliability implementation plan

Approved scope: October 22 review findings and the owner's instruction to implement them. Work in the existing codex/match-predictions worktree; no deployment, merge or production database writes.

1. Isolate reporting and pickup persistence from prediction errors. Commit the official match report independently; immediate prediction attempts are best effort and logged safely. Preserve the ordinary ELO scheduling and match arming paths. Test injected observation/payout/finalization failures.
2. Reconcile completed match rows on startup and periodically, independently per game. Read official winner and validate original teams/map/server consistently before payout. Reconcile already-settled outcomes into owner correction review when the official result changes. Never duplicate payouts. Keep house-funded corrections owner-confirmed.
3. Preserve persisted deadlines through restart/monitoring recovery, never extend or reconstruct them. Missing deadlines and actual terms conflicts stay reviewed. A stale prior unresolved prediction must not reserve a server whose official match is complete, and base pickup creation must survive prediction unavailability.
4. Honor event freshness for live markers; refresh validated roster Steam links before the first countdown and audit the mappings used. Keep all eight and the selected map mandatory, and retain the full 120 seconds. Update the in-memory restart target after an authorized setmap.
5. Share official-terms validation across automated settlement and owner controls; preserve explicit owner map-change acceptance. Use exact integer accounting for aggregate point totals.
6. Add failing regressions before each implementation, run focused tests, run the relevant suite, perform independent review, update operator documentation, commit and push to the existing PR. Report any platform-specific test limits accurately.
Implementation, documentation, independent re-review and final verification are complete. All 339 repository tests passed (179 predictions). Commit/push uses the existing feature branch and PR; deployment and merge remain outside this task.
