#!/bin/bash
# Simple nightly backup for TFCBot databases
# Location: /root/tfcbot/backup.sh

BACKUP_DIR="/root/tfcbot/backups"
TS=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$BACKUP_DIR"

for DB in elo.db bot.db; do
  if [ -f "/root/tfcbot/$DB" ]; then
    cp "/root/tfcbot/$DB" "$BACKUP_DIR/${DB%.db}_$TS.db"
  fi
done

# Keep only the last 14 backups
ls -1t "$BACKUP_DIR"/*.db | tail -n +15 | xargs -r rm --
