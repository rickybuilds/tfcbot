#!/usr/bin/env bash
set -euo pipefail

DB="${1:-/root/tfcbot/elo.db}"
OUT="${2:-/root/tfcbot/compare_sample_15.tsv}"

sqlite3 -header -tabs "$DB" "
SELECT
  match_id,
  hampalyzer_url,
  tfcstats_url
FROM matches
WHERE hampalyzer_url IS NOT NULL
  AND TRIM(hampalyzer_url) != ''
  AND tfcstats_url IS NOT NULL
  AND TRIM(tfcstats_url) != ''
ORDER BY RANDOM()
LIMIT 15;
" > "$OUT"

echo "Wrote: $OUT"
cat "$OUT"
