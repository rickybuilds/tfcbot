#!/usr/bin/env bash
set -euo pipefail

DB="${1:-/root/tfcbot/elo.db}"
OUT="${2:-/root/tfcbot/mixed_import_sample_30.tsv}"

sqlite3 -header -tabs "$DB" "
WITH tfc AS (
  SELECT
    match_id,
    hampalyzer_url,
    tfcstats_url,
    'tfcstats' AS preferred_source
  FROM matches
  WHERE tfcstats_url IS NOT NULL
    AND TRIM(tfcstats_url) != ''
  ORDER BY RANDOM()
  LIMIT 22
),
hamp AS (
  SELECT
    match_id,
    hampalyzer_url,
    tfcstats_url,
    'hampalyzer' AS preferred_source
  FROM matches
  WHERE (tfcstats_url IS NULL OR TRIM(tfcstats_url) = '')
    AND hampalyzer_url IS NOT NULL
    AND TRIM(hampalyzer_url) != ''
  ORDER BY RANDOM()
  LIMIT 8
)
SELECT *
FROM (
  SELECT * FROM tfc
  UNION ALL
  SELECT * FROM hamp
)
ORDER BY RANDOM();
" > "$OUT"

echo "Wrote: $OUT"
cat "$OUT"
