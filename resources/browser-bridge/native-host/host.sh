#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${SAILFISH_ELECTRON_EXE:-}" && -x "$SAILFISH_ELECTRON_EXE" ]]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$SAILFISH_ELECTRON_EXE" "$DIR/host.mjs" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/host.mjs" "$@"
fi
echo "Node.js or SAILFISH_ELECTRON_EXE required" >&2
exit 1
