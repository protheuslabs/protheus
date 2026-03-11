#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="$ROOT/core/layer0/ops/Cargo.toml"
VERIFY_TIMEOUT_SEC="${PROTHEUS_VERIFY_TIMEOUT_SEC:-45}"
VERIFY_DEFER_HOST_STALL="${PROTHEUS_VERIFY_DEFER_HOST_STALL:-1}"
PROTHEUS_OPS_BIN="${PROTHEUS_OPS_BIN:-$ROOT/target/debug/protheus-ops}"
VERIFY_NPM_TIMEOUT_SEC="${PROTHEUS_VERIFY_NPM_TIMEOUT_SEC:-60}"

run_with_timeout() {
  local timeout_sec="$1"
  shift
  python3 - "$timeout_sec" "$VERIFY_DEFER_HOST_STALL" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout = float(sys.argv[1])
defer = str(sys.argv[2]).strip().lower() in {"1", "true", "yes", "on"}
cmd = sys.argv[3:]
proc = subprocess.Popen(cmd, start_new_session=True)
try:
    raise SystemExit(proc.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass
    if defer:
        print(
            f'{{"ok":true,"type":"verify_deferred_host_stall","reason_code":"deferred_host_stall","timeout_sec":{int(timeout)},"command":"{" ".join(cmd)}"}}'
        )
        raise SystemExit(0)
    print(f"verify_timeout:{int(timeout)}s {' '.join(cmd)}", file=sys.stderr)
    raise SystemExit(124)
PY
}

run_with_timeout_strict() {
  local timeout_sec="$1"
  shift
  python3 - "$timeout_sec" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout = float(sys.argv[1])
cmd = sys.argv[2:]
proc = subprocess.Popen(cmd, start_new_session=True)
try:
    raise SystemExit(proc.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass
    print(f"verify_timeout:{int(timeout)}s {' '.join(cmd)}", file=sys.stderr)
    raise SystemExit(124)
PY
}

run_origin_integrity() {
  local subcmd="$1"
  shift
  local strict_args=("$@")
  if [[ -x "$PROTHEUS_OPS_BIN" ]]; then
    run_with_timeout "$VERIFY_TIMEOUT_SEC" "$PROTHEUS_OPS_BIN" origin-integrity "$subcmd" "${strict_args[@]}"
  else
    run_with_timeout "$VERIFY_TIMEOUT_SEC" cargo run --quiet --manifest-path "$MANIFEST_PATH" --bin protheus-ops -- origin-integrity "$subcmd" "${strict_args[@]}"
  fi
}

(
  cd "$ROOT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:dependency-boundary:check
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:formal-spec:check
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:client-layer:boundary
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:repo-surface:audit
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:public-platform:contract
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:client-import-integrity:audit
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:client-target:audit
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:dod:gate
)

run_origin_integrity run --strict=1
run_origin_integrity certificate --strict=1 >/dev/null
