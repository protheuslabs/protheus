#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_PATH="$ROOT/core/layer0/ops/Cargo.toml"
VERIFY_TIMEOUT_SEC="${PROTHEUS_VERIFY_TIMEOUT_SEC:-45}"
VERIFY_DEFER_HOST_STALL="${PROTHEUS_VERIFY_DEFER_HOST_STALL:-1}"
PROTHEUS_OPS_BIN="${PROTHEUS_OPS_BIN:-$ROOT/target/debug/protheus-ops}"
VERIFY_NPM_TIMEOUT_SEC="${PROTHEUS_VERIFY_NPM_TIMEOUT_SEC:-60}"
VERIFY_ARTIFACT_MODE="${PROTHEUS_VERIFY_ARTIFACT_MODE:-ephemeral}"

if [[ "$VERIFY_ARTIFACT_MODE" == "ephemeral" ]]; then
  VERIFY_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/protheus-verify-XXXXXX")"
  trap 'rm -rf "${VERIFY_TMP_DIR:-}"' EXIT
  CLIENT_LAYER_AUDIT_OUT="$VERIFY_TMP_DIR/client_layer_boundary_audit_current.json"
  MODULE_COHESION_OUT_JSON="$VERIFY_TMP_DIR/module_cohesion_audit_current.json"
  MODULE_COHESION_OUT_MD="$VERIFY_TMP_DIR/MODULE_COHESION_AUDIT_CURRENT.md"
  CLIENT_IMPORT_INTEGRITY_OUT="$VERIFY_TMP_DIR/client_import_integrity_audit_current.json"
  CLIENT_SCOPE_OUT="$VERIFY_TMP_DIR/client_scope_inventory_current.json"
  CLIENT_SURFACE_OUT="$VERIFY_TMP_DIR/client_surface_disposition_current.json"
  CLIENT_TARGET_OUT="$VERIFY_TMP_DIR/client_target_contract_audit_current.json"
else
  CLIENT_LAYER_AUDIT_OUT="$ROOT/artifacts/client_layer_boundary_audit_current.json"
  MODULE_COHESION_OUT_JSON="$ROOT/artifacts/module_cohesion_audit_current.json"
  MODULE_COHESION_OUT_MD="$ROOT/docs/workspace/MODULE_COHESION_AUDIT_CURRENT.md"
  CLIENT_IMPORT_INTEGRITY_OUT="$ROOT/artifacts/client_import_integrity_audit_current.json"
  CLIENT_SCOPE_OUT="$ROOT/artifacts/client_scope_inventory_current.json"
  CLIENT_SURFACE_OUT="$ROOT/artifacts/client_surface_disposition_current.json"
  CLIENT_TARGET_OUT="$ROOT/artifacts/client_target_contract_audit_current.json"
fi

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
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/client_layer_boundary_audit.mjs --strict=1 --out="$CLIENT_LAYER_AUDIT_OUT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/module_cohesion_policy_audit.mjs --strict=1 --out-json="$MODULE_COHESION_OUT_JSON" --out-markdown="$MODULE_COHESION_OUT_MD"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:repo-surface:audit
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:public-platform:contract
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/client_import_integrity_audit.mjs --strict=1 --out="$CLIENT_IMPORT_INTEGRITY_OUT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/client_scope_inventory.mjs --out="$CLIENT_SCOPE_OUT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/client_surface_disposition.mjs --out="$CLIENT_SURFACE_OUT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" node scripts/ci/client_target_contract_audit.mjs --strict=1 --scope="$CLIENT_SCOPE_OUT" --boundary="$CLIENT_LAYER_AUDIT_OUT" --disposition="$CLIENT_SURFACE_OUT" --out="$CLIENT_TARGET_OUT"
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s ops:dod:gate
  run_with_timeout_strict "$VERIFY_NPM_TIMEOUT_SEC" npm run -s test:ops:srs-contract-runtime-evidence
)

run_origin_integrity run --strict=1
run_origin_integrity certificate --strict=1 >/dev/null
