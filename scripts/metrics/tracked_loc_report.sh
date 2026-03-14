#!/usr/bin/env bash
set -euo pipefail

# Canonical tracked LOC report for Rust/TypeScript/JavaScript migration progress.
# Counts tracked lines at a git ref using git grep to stay ref-accurate.

REF="HEAD"
BASE_REF=""
OUT_PATH=""
MIN_RUST_SHARE=""

for arg in "$@"; do
  case "$arg" in
    --ref=*)
      REF="${arg#*=}"
      ;;
    --base-ref=*)
      BASE_REF="${arg#*=}"
      ;;
    --out=*)
      OUT_PATH="${arg#*=}"
      ;;
    --min-rust-share=*)
      MIN_RUST_SHARE="${arg#*=}"
      ;;
    --help|-h)
      cat <<'USAGE'
Usage:
  scripts/metrics/tracked_loc_report.sh [--ref=<gitref>] [--base-ref=<gitref>] [--out=<path>] [--min-rust-share=<pct>]

Examples:
  scripts/metrics/tracked_loc_report.sh --ref=HEAD
  scripts/metrics/tracked_loc_report.sh --ref=HEAD --base-ref=origin/main --out=core/local/artifacts/rust_share.json
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if ! git rev-parse --verify "$REF" >/dev/null 2>&1; then
  echo "invalid ref: $REF" >&2
  exit 2
fi

if [[ -n "$BASE_REF" ]] && ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "invalid base ref: $BASE_REF" >&2
  exit 2
fi

count_ext_lines() {
  local ref="$1"
  local ext="$2"
  # git grep exits non-zero when there are no matches; treat as zero-line case.
  local raw
  raw="$( (git grep -I -n '^' "$ref" -- "*.${ext}" || true) | wc -l | awk '{print $1}')"
  echo "$raw"
}

compute_counts() {
  local ref="$1"
  local rs ts js total rust_share
  rs="$(count_ext_lines "$ref" "rs")"
  ts="$(count_ext_lines "$ref" "ts")"
  js="$(count_ext_lines "$ref" "js")"
  total=$((rs + ts + js))
  if [[ "$total" -gt 0 ]]; then
    rust_share="$(awk -v a="$rs" -v b="$total" 'BEGIN { printf "%.3f", (a*100.0)/b }')"
  else
    rust_share="0.000"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$rs" "$ts" "$js" "$total" "$rust_share"
}

IFS=$'\t' read -r RS TS JS TOTAL RUST_SHARE < <(compute_counts "$REF")

BASE_BLOCK=""
DELTA_BLOCK=""
if [[ -n "$BASE_REF" ]]; then
  IFS=$'\t' read -r B_RS B_TS B_JS B_TOTAL B_RUST_SHARE < <(compute_counts "$BASE_REF")
  D_RS=$((RS - B_RS))
  D_TS=$((TS - B_TS))
  D_JS=$((JS - B_JS))
  D_TOTAL=$((TOTAL - B_TOTAL))
  D_RUST_SHARE="$(awk -v a="$RUST_SHARE" -v b="$B_RUST_SHARE" 'BEGIN { printf "%.3f", (a-b) }')"
  BASE_BLOCK=$(cat <<JSON
,
  "base_ref": "${BASE_REF}",
  "base_counts": {
    "rs": ${B_RS},
    "ts": ${B_TS},
    "js": ${B_JS},
    "total": ${B_TOTAL}
  },
  "base_rust_share_pct": ${B_RUST_SHARE},
  "delta": {
    "rs": ${D_RS},
    "ts": ${D_TS},
    "js": ${D_JS},
    "total": ${D_TOTAL},
    "rust_share_pct": ${D_RUST_SHARE}
  }
JSON
)
fi

REPORT=$(cat <<JSON
{
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "ref": "${REF}",
  "revision": "$(git rev-parse "$REF")",
  "counts": {
    "rs": ${RS},
    "ts": ${TS},
    "js": ${JS},
    "total": ${TOTAL}
  },
  "rust_share_pct": ${RUST_SHARE}${BASE_BLOCK}
}
JSON
)

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf '%s\n' "$REPORT" >"$OUT_PATH"
fi

printf '%s\n' "$REPORT"

if [[ -n "$MIN_RUST_SHARE" ]]; then
  MEETS="$(awk -v a="$RUST_SHARE" -v b="$MIN_RUST_SHARE" 'BEGIN { if (a + 0 >= b + 0) print "1"; else print "0"; }')"
  if [[ "$MEETS" != "1" ]]; then
    echo "rust share gate failed: ${RUST_SHARE}% < ${MIN_RUST_SHARE}%" >&2
    exit 1
  fi
fi
