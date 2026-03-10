#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
POLICY_PATH="${PROTHEUS_EDGE_POLICY_PATH:-$ROOT_DIR/client/runtime/config/protheus_edge_policy.json}"

echo "[protheus-edge] preparing iOS/Tauri wrapper"
node "$ROOT_DIR/client/runtime/systems/ops/mobile_wrapper_distribution_pack.js" verify --owner="${PROTHEUS_OWNER:-jay}" --target=ios_tauri --policy="$ROOT_DIR/client/runtime/config/mobile_wrapper_distribution_pack_policy.json" --strict=1 --apply=0
node "$ROOT_DIR/client/runtime/systems/edge/protheus_edge_runtime.js" configure --owner="${PROTHEUS_OWNER:-jay}" --profile=mobile_seed --cache-mode=memfs_cached --remote-spine="${PROTHEUS_REMOTE_SPINE:-}" --policy="$POLICY_PATH"
