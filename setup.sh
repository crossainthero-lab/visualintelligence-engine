#!/usr/bin/env bash
# One-time setup: virtualenv, Python deps, Playwright Chromium, config template.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null || die "python3 not found (sudo apt install python3 python3-venv)"
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Python >= 3.11 required"
"$PY" -c 'import venv, ensurepip' 2>/dev/null || die "python3-venv missing (sudo apt install python3-venv)"

for bin in ffmpeg ffprobe; do
  command -v "$bin" >/dev/null || die "$bin not found (sudo apt install ffmpeg)"
done

say "Creating .venv"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
say "Installing Python dependencies"
.venv/bin/python -m pip install --quiet -r requirements.txt

say "Installing Playwright Chromium"
.venv/bin/python -m playwright install chromium
if ! .venv/bin/python -c 'from playwright.sync_api import sync_playwright as s
with s() as p:
    b = p.chromium.launch(headless=True); b.close()' 2>/dev/null; then
  echo "Chromium cannot start; it probably needs system libraries. Run:" >&2
  echo "  sudo $(pwd)/.venv/bin/python -m playwright install-deps chromium" >&2
fi

if [ ! -f config.toml ]; then
  cp config.example.toml config.toml
  say "Created config.toml (git-ignored). Set [llm] endpoint/model there; export VIE_LLM_API_KEY for the token."
fi
chmod +x collect.sh setup.sh; [ -f analyse.sh ] && chmod +x analyse.sh || true
say "Done. Next: ./collect.sh --check"
