#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Clean any existing ledger state and temporary files
rm -rf "${ROOT_DIR}/.agent-ledger"
rm -rf "${ROOT_DIR}"/.*.tmp.*
rm -rf "${ROOT_DIR}"/*.tmp

echo "agent-ledger workspace reset completed."
exit 0
