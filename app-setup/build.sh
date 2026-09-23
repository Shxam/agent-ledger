#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Ensure bin/agent-ledger is executable
chmod +x "${ROOT_DIR}/bin/agent-ledger"

# If a standard binary directory is writable, create a symlink
if [ -w "/usr/local/bin" ]; then
  ln -sf "${ROOT_DIR}/bin/agent-ledger" "/usr/local/bin/agent-ledger"
elif [ -d "${HOME}/.local/bin" ] && [ -w "${HOME}/.local/bin" ]; then
  ln -sf "${ROOT_DIR}/bin/agent-ledger" "${HOME}/.local/bin/agent-ledger"
fi

# Export PATH addition for current subshell environments
export PATH="${ROOT_DIR}/bin:${PATH}"

echo "agent-ledger build completed successfully."
exit 0
