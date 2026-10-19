#!/usr/bin/env bash
# Remove the service. Your database and media are NOT deleted unless you pass --purge-data.
set -euo pipefail
SCOPE=user PURGE=0
for a in "$@"; do case "$a" in --system) SCOPE=system;; --purge-data) PURGE=1;; esac; done
if [ "$SCOPE" = user ]; then UNIT="$HOME/.config/systemd/user/visualintelligence.service"; CTL="systemctl --user"; SUDO=""; ENV="$HOME/.config/visualintelligence/server.env"
else UNIT=/etc/systemd/system/visualintelligence.service; CTL=systemctl; SUDO=sudo; ENV=/etc/visualintelligence/server.env; fi
DATA="$(grep -h '^VIE_DATA_DIR=' "$ENV" 2>/dev/null | cut -d= -f2- || true)"
$SUDO $CTL disable --now visualintelligence.service 2>/dev/null || true
$SUDO rm -f "$UNIT" "$ENV"; $SUDO $CTL daemon-reload
echo "Service removed."
if [ "$PURGE" = 1 ] && [ -n "$DATA" ]; then echo "Deleting data directory $DATA"; rm -rf -- "$DATA"; else echo "Data kept${DATA:+ at $DATA}. Re-run with --purge-data to delete it."; fi
