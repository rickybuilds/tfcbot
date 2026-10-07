# Hampalyzer provenance

Upstream: https://github.com/bananahampster/hampalyzer

Pinned commit: `aeaf984ff1d0d69eb25aafe600f7ba7961458996` (retrieved 2026-10-07).

`upstream/` contains the supplied project and its GPL-3.0-or-later license. The parsing core in `upstream/src/` is unmodified. No Name extensions live in `src/` and the bot's JSON importer. This parser package and its extensions use GPL-3.0-or-later; preserve upstream attribution and license when distributing it.

The only upstream test changes remove the original developer's absolute path from `log_name` snapshots. The test runner uses the snapshots' original America/Los_Angeles timezone. Production parsing does not inherit that test timezone.

Our service uses Hampalyzer's `Parser` directly and stores all structured summaries in SQLite through tfcbot, rather than running upstream's PostgreSQL/HTML server. Replacing this pinned copy requires reviewing parser output compatibility and running both the upstream suite and No Name tests. Increment `PARSER_VERSION` after changes that should invalidate cached results.
