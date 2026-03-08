#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="$ROOT/core/layer0/ops/Cargo.toml"

(
  cd "$ROOT"
  npm run -s ops:dependency-boundary:check
  npm run -s ops:formal-spec:check
)

cargo run --quiet --manifest-path "$MANIFEST_PATH" --bin protheus-ops -- origin-integrity run --strict=1
cargo run --quiet --manifest-path "$MANIFEST_PATH" --bin protheus-ops -- origin-integrity certificate --strict=1 >/dev/null
