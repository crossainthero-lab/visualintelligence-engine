#!/usr/bin/env bash
# Helper CLI used by analysis agents:  ./vie.sh prep session <dir> | prep frames <dir> <id> --at T.. | validate <dir> | export
set -euo pipefail
ROOT="$(dirname "$(readlink -f "$0")")"
cmd="${1:?usage: vie.sh prep|validate|export ...}"; shift
exec env PYTHONPATH="$ROOT" "$ROOT/.venv/bin/python" -I -c "import sys; sys.path.insert(0, '$ROOT'); from vie.$cmd import main; sys.exit(main())" "$@"
