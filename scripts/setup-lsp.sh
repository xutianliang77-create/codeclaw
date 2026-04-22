#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv-lsp"
PYTHON_BIN="${CODECLAW_PYTHON:-python3}"

echo "Using Python: $PYTHON_BIN"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python runtime not found: $PYTHON_BIN" >&2
  exit 1
fi

if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
  echo "Python venv module is unavailable for $PYTHON_BIN" >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"

"$VENV_PYTHON" -m pip install --upgrade pip
"$VENV_PYTHON" -m pip install -r "$ROOT_DIR/requirements-lsp.txt"

TS_LSP_DIR="$("$VENV_PYTHON" - <<'PY'
import site
from pathlib import Path

for site_path in site.getsitepackages():
    candidate = Path(site_path) / "multilspy" / "language_servers" / "typescript_language_server" / "static" / "ts-lsp"
    print(candidate)
    break
PY
)"

mkdir -p "$TS_LSP_DIR"
npm install --prefix "$TS_LSP_DIR" typescript@5.5.4 typescript-language-server@4.3.3

echo ""
echo "LSP runtime is ready."
echo "Virtualenv: $VENV_DIR"
echo "Python: $VENV_PYTHON"
echo "To force-enable real LSP explicitly:"
echo "  CODECLAW_ENABLE_REAL_LSP=1 node dist/cli.js --plain"
