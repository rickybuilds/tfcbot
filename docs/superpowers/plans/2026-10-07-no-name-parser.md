# No Name Parser Implementation Plan

**Goal:** Same logs to public TFCStats, public Hampalyzer and local Hampalyzer parsing directly into SQLite, including complete stats and SG analytics. Existing website supplies the UI.

**Architecture:** Pinned GPL upstream core, headless TypeScript service, private log archives, JSON importer and CommonJS bot integration. Node 22 matches existing native SQLite dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-no-name-parser-design.md`

## Implementation

- [x] Pin upstream source/license; normalize snapshots for portable paths/timezone.
- [x] Write failing SG sequence tests and implement lifetimes/levels/uncertainty.
- [x] Implement private archives, authenticated API, CLI and operational package.
- [x] Preserve complete Hampalyzer summaries and normalized gameplay events.
- [x] Implement transactional SQLite import and compatible website projections.
- [x] Wire pickup/casual paths to all three consumers, retaining public links.
- [x] Remove automatic HTML scraping and prototype UI per clarified scope.
- [x] Verify parser/upstream suite and bot suite; inspect supplied logs privately.
- [x] Complete independent review; fix stalled uploads, historical provenance and SG team-change keys, with regression tests.
- [x] Run real-log HTTP/database import and archive reparse: 8 players, 532 kills, 12 caps, 31 SG lifetimes; no duplicated rows.
- [ ] Deploy on bot host when its encrypted SSH identity can be unlocked; unattended authentication is unavailable.

## Review focus

Legacy history preservation, round team swaps, complete result retention, atomic replacements, SG confidence, failed-consumer cleanup, bounded requests and private logs. Historical SG reconstruction requires retained source logs.
