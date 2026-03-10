#!/usr/bin/env bash
set -euo pipefail
# Layer ownership: apps/personas (authoritative)
# Thin compatibility wrapper only.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${SCRIPT_DIR}"
while [ ! -f "${DIR}/Cargo.toml" ] && [ "${DIR}" != "/" ]; do DIR="$(dirname "${DIR}")"; done
ROOT="${DIR}"
exec bash "${ROOT}/apps/personas/rohan-kapoor/cron/rohan-activity.sh" "$@"
