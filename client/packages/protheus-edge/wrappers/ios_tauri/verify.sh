#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
node "$ROOT_DIR/client/systems/ops/mobile_wrapper_distribution_pack.js" verify --owner="${PROTHEUS_OWNER:-jay}" --target=ios_tauri --policy="$ROOT_DIR/client/config/mobile_wrapper_distribution_pack_policy.json" --strict=1 --apply=0
