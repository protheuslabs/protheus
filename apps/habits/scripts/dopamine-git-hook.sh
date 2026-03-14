#!/usr/bin/env bash
#
# post-commit hook - Auto-capture artifacts after each git commit
# Install:
#   WORKSPACE_ROOT="${OPENCLAW_WORKSPACE:-${PROTHEUS_WORKSPACE:-$HOME/.openclaw/workspace}}"
#   ln -sf "$WORKSPACE_ROOT/apps/habits/scripts/dopamine-git-hook.sh" .git/hooks/post-commit
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${SCRIPT_DIR}"
while [ ! -f "${DIR}/Cargo.toml" ] && [ "${DIR}" != "/" ]; do DIR="$(dirname "${DIR}")"; done
ROOT="${DIR}"

cd "${ROOT}" || exit 0

# Run autocap silently (suppress output unless error)
"${ROOT}/client/cognition/habits/scripts/dop" autocap git > /dev/null 2>&1 || true

# Optional: Log that artifacts were captured
# echo "🤖 Artifacts auto-captured from commit" >&2

exit 0
