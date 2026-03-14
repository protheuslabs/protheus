#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROOF_FILE="$ROOT/proofs/layer0/Layer0Invariants.lean"

LEAN_BIN="${LEAN_BIN:-}"
if [[ -z "$LEAN_BIN" ]]; then
  if [[ -x "$HOME/.elan/bin/lean" ]]; then
    LEAN_BIN="$HOME/.elan/bin/lean"
  elif command -v lean >/dev/null 2>&1; then
    LEAN_BIN="$(command -v lean)"
  else
    echo "BLOCKED — missing Lean toolchain (lean binary not found)" >&2
    exit 2
  fi
fi

"$LEAN_BIN" "$PROOF_FILE"

ARTIFACT_PATH="$ROOT/core/local/artifacts/layer0_invariant_proof_pack.json"
mkdir -p "$(dirname "$ARTIFACT_PATH")"

python3 - "$PROOF_FILE" "$ARTIFACT_PATH" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys

proof_path = pathlib.Path(sys.argv[1])
artifact_path = pathlib.Path(sys.argv[2])
proof_text = proof_path.read_text(encoding="utf-8")
payload = {
    "ok": True,
    "type": "layer0_invariant_proof_pack",
    "proof_file": str(proof_path),
    "proof_sha256": hashlib.sha256(proof_text.encode("utf-8")).hexdigest(),
    "verified_at": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    "invariants": [
        "conduit_only_path",
        "constitution_hardening_merkle_operator_approval",
        "receipt_state_binding_and_anti_forgery",
        "fail_closed_boundary",
    ],
}
artifact_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(str(artifact_path))
PY
