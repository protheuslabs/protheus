#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

bash proofs/layer0/verify.sh
cargo test --manifest-path core/layer0/ops/Cargo.toml --test v8_runtime_proof
