#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

node client/systems/ops/competitive_benchmark_matrix.js run --scenario="${SCENARIO:-deterministic_001}" "$@"
node client/systems/ops/competitive_benchmark_matrix.js status
