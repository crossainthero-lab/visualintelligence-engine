#!/usr/bin/env bash
# Install / upgrade the server edition as a systemd service. Idempotent. Needs: node >= 22.18, ffmpeg.
#   deploy/install.sh [--user|--system] [--port 3100] [--host 192.168.1.50] [--data /srv/vie] [--trusted-lan]
# --user (default) installs a systemd *user* service (no root). --system needs sudo.
# Nothing here opens firewall ports, installs models, or touches other services.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SCOPE=user PORT=3100 HOST=127.0.0.1 DATA="$APP_DIR/data" TRUSTED=0
while [ $# -gt 0 ]; do case "$1" in
  --user) SCOPE=user;; --system) SCOPE=system;; --port) PORT="$2"; shift;; --host) HOST="$2"; shift;;
  --data) DATA="$2"; shift;; --trusted-lan) TRUSTED=1;; *) echo "unknown option $1" >&2; exit 1;; esac; shift; done
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
NODE="$(command -v node)" || { echo "node >= 22.18 not found" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a==22&&b>=18)?0:1)' || { echo "node >= 22.18 required (have $("$NODE" -v))" >&2; exit 1; }
command -v ffmpeg >/dev/null || echo "WARNING: ffmpeg not found; thumbnails and analysis frame extraction need it (sudo apt install ffmpeg)"
ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN && { echo "port $PORT is already in use; pick another with --port" >&2; exit 1; } || true

cd "$APP_DIR"
say "Installing dependencies and building"
npm ci --no-audit --no-fund
npm run build
mkdir -p "$DATA"; chmod 700 "$DATA"

if [ "$SCOPE" = user ]; then UNIT_DIR="$HOME/.config/systemd/user"; ENV_FILE="$HOME/.config/visualintelligence/server.env"; WANTED=default.target; CTL="systemctl --user"
else UNIT_DIR=/etc/systemd/system; ENV_FILE=/etc/visualintelligence/server.env; WANTED=multi-user.target; CTL="systemctl"; fi
SUDO=""; [ "$SCOPE" = system ] && SUDO=sudo
$SUDO mkdir -p "$UNIT_DIR" "$(dirname "$ENV_FILE")"

if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE (secrets are generated once, mode 600)"
  TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  {
    echo "VIE_HOST=$HOST"; echo "VIE_PORT=$PORT"; echo "VIE_DATA_DIR=$DATA"; echo "VIE_MEDIA_DIR=$DATA/media"
    if [ "$TRUSTED" = 1 ]; then echo "VIE_TRUSTED_LAN=1"; echo "# VIE_AUTH_TOKEN=  (unset: anyone on the LAN can use the dashboard)"; else echo "VIE_AUTH_TOKEN=$TOKEN"; fi
    echo "# VIE_MCP_TOKEN=   # set to enable the remote MCP endpoint (/mcp); VIE_MCP_REMOTE_WRITE=1 allows write tools"
  } | $SUDO tee "$ENV_FILE" >/dev/null
  $SUDO chmod 600 "$ENV_FILE"
else say "Keeping existing $ENV_FILE"; fi

say "Installing service"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@ENV_FILE@#$ENV_FILE#g" -e "s#@NODE@#$NODE#g" -e "s#@DATA_DIR@#$DATA#g" -e "s#@WANTED_BY@#$WANTED#g" deploy/visualintelligence.service | $SUDO tee "$UNIT_DIR/visualintelligence.service" >/dev/null
$SUDO $CTL daemon-reload
$SUDO $CTL enable --now visualintelligence.service
[ "$SCOPE" = user ] && command -v loginctl >/dev/null && loginctl enable-linger "$USER" 2>/dev/null || true
sleep 3
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo && say "Running: http://$HOST:$PORT" || { $SUDO $CTL status visualintelligence.service --no-pager | tail -20; exit 1; }
