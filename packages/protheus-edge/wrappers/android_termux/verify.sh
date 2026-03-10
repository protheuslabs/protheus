#!/usr/bin/env sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
node "$ROOT_DIR/client/runtime/systems/ops/mobile_wrapper_distribution_pack.js" verify --owner="${PROTHEUS_OWNER:-jay}" --target=android_termux --policy="$ROOT_DIR/client/runtime/config/mobile_wrapper_distribution_pack_policy.json" --strict=1 --apply=0
