#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

node client/runtime/systems/ops/local_runtime_partitioner.js init >/dev/null
node client/runtime/systems/sensory/conversation_eye_bootstrap.js ensure --apply=1 >/dev/null
node client/runtime/systems/ops/migrate_to_planes.js run --apply=1 --move-untracked=1
