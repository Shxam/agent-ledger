#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

export PATH="${ROOT_DIR}/bin:${PATH}"

# Verify executable is functional
if command -v agent-ledger >/dev/null 2>&1; then
  echo "agent-ledger is ready on PATH."
elif [ -x "${ROOT_DIR}/bin/agent-ledger" ]; then
  echo "agent-ledger is executable at ${ROOT_DIR}/bin/agent-ledger."
else
  echo "Error: agent-ledger executable not found." >&2
  exit 1
fi

exit 0
