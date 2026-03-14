#!/usr/bin/env bash
set -euo pipefail
ROLE="operator"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --role=*) ROLE="${arg#*=}" ;;
    --dry-run=1) DRY_RUN=1 ;;
  esac
done
mkdir -p local/state/ops/onboarding_portal
cat > "local/state/ops/onboarding_portal/bootstrap_${ROLE}.json" <<JSON
{
  "schema_id": "onboarding_bootstrap_receipt",
  "schema_version": "1.0",
  "ts": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "role": "$ROLE",
  "dry_run": $DRY_RUN,
  "ok": true
}
JSON
echo "onboarding bootstrap complete for role=$ROLE dry_run=$DRY_RUN"
