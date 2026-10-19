#!/usr/bin/env bash
# Consistent database snapshot (SQLite VACUUM INTO, safe while running) + keep the newest N. Run from cron/systemd timer.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
KEEP="${1:-14}"
node bin/visualintelligence.mjs backup --json >/dev/null
DIR="${VIE_DATA_DIR:-./data}/backups"
ls -1t "$DIR"/vie-*.sqlite 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f --
echo "backups: $(ls -1 "$DIR"/vie-*.sqlite | wc -l) in $DIR"
