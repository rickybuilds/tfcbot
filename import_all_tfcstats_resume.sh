#!/usr/bin/env bash
set -u

DB="/root/tfcbot/elo.db"
BOTDIR="/root/tfcbot"
LOG="$BOTDIR/tfcstats_bulk_import_resume.log"
LIST="$BOTDIR/tfcstats_bulk_import.tsv"

cd "$BOTDIR"

if [ ! -f "$LIST" ]; then
  sqlite3 -tabs "$DB" "
  SELECT match_id, tfcstats_url
  FROM matches
  WHERE tfcstats_url IS NOT NULL
    AND TRIM(tfcstats_url) != ''
  ORDER BY match_id;
  " > "$LIST"
fi

echo "Resume import started: $(date)" | tee -a "$LOG"

while IFS=$'\t' read -r match_id tfcstats_url; do
  [ -z "${match_id:-}" ] && continue

  already=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tfcstats_imports WHERE match_id='$match_id';")
  if [ "$already" != "0" ]; then
    echo "[SKIP] $match_id already imported" | tee -a "$LOG"
    continue
  fi

  echo "=== $match_id $tfcstats_url ===" | tee -a "$LOG"

  if timeout 120s node "$BOTDIR/tfcstatsImport.js" "$match_id" "$tfcstats_url" >> "$LOG" 2>&1; then
    echo "[OK] $match_id" | tee -a "$LOG"
  else
    echo "[FAILED] $match_id" | tee -a "$LOG"
  fi

done < "$LIST"

echo "Resume import finished: $(date)" | tee -a "$LOG"
