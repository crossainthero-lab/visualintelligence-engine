#!/usr/bin/env bash
# Start a new Scroll Session. Ctrl+C stops it safely. Options: ./collect.sh --help
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[ -x .venv/bin/python ] || { echo "First run: setting up..."; ./setup.sh; }
exec .venv/bin/python -m vie.collect_cli "$@"
