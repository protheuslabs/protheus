#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
POLICY_PATH="${PROTHEUS_EDGE_POLICY_PATH:-$ROOT_DIR/client/runtime/config/protheus_edge_policy.json}"

echo "[protheus-edge] starting Android/Termux runtime"
node "$ROOT_DIR/client/runtime/systems/edge/protheus_edge_runtime.js" start --owner="${PROTHEUS_OWNER:-jay}" --profile=mobile_seed --cache-mode=memfs_cached --online="${PROTHEUS_ONLINE:-1}" --remote-spine="${PROTHEUS_REMOTE_SPINE:-}" --contract-lane-verified=1 --policy="$POLICY_PATH"
