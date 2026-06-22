#!/usr/bin/env bash
set -euo pipefail

DB="/root/tfcbot/elo.db"
BOTDIR="/root/tfcbot"
LOG="$BOTDIR/tfcstats_bulk_import.log"
LIST="$BOTDIR/tfcstats_bulk_import.tsv"

cd "$BOTDIR"

sqlite3 -tabs "$DB" "
SELECT match_id, tfcstats_url
FROM matches
WHERE tfcstats_url IS NOT NULL
  AND TRIM(tfcstats_url) != ''
ORDER BY match_id;
" > "$LIST"

echo "Starting bulk import: $(date)" | tee -a "$LOG"
echo "List: $LIST" | tee -a "$LOG"

while IFS=$'\t' read -r match_id tfcstats_url; do
  [ -z "${match_id:-}" ] && continue

  echo "=== $match_id $tfcstats_url ===" | tee -a "$LOG"

  if node "$BOTDIR/tfcstatsImport.js" "$match_id" "$tfcstats_url" --force >> "$LOG" 2>&1; then
    echo "[OK] $match_id" | tee -a "$LOG"
  else
    echo "[FAILED] $match_id" | tee -a "$LOG"
  fi

done < "$LIST"

echo "Finished bulk import: $(date)" | tee -a "$LOG"
