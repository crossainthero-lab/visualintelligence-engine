#!/usr/bin/env bash
# Analyse a Scroll Session with Claude Code or Codex. Independent of collect.sh. Options: ./analyse.sh --help
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[ -x .venv/bin/python ] || { echo "First run: setting up..."; ./setup.sh; }
exec .venv/bin/python -m vie.analyse_cli "$@"
