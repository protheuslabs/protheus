#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not in a git work tree" >&2
  exit 1
fi

count_lines() {
  local pattern="$1"
  local out
  out=$(git ls-files "$pattern" | xargs wc -l 2>/dev/null || true)
  if [ -z "$out" ]; then
    echo 0
  else
    echo "$out" | tail -n1 | awk '{print $1+0}'
  fi
}

count_bytes() {
  local pattern="$1"
  local out
  out=$(git ls-files "$pattern" | xargs wc -c 2>/dev/null || true)
  if [ -z "$out" ]; then
    echo 0
  else
    echo "$out" | tail -n1 | awk '{print $1+0}'
  fi
}

rs_lines=$(count_lines '*.rs')
ts_lines=$(count_lines '*.ts')
js_lines=$(count_lines '*.js')
all_lines=$(git ls-files | xargs wc -l 2>/dev/null | tail -n1 | awk '{print $1+0}')

rs_bytes=$(count_bytes '*.rs')
ts_bytes=$(count_bytes '*.ts')
js_bytes=$(count_bytes '*.js')

repo_pct="0.000"
if [ "$all_lines" -gt 0 ]; then
  repo_pct=$(awk -v a="$rs_lines" -v b="$all_lines" 'BEGIN{printf "%.3f", (a/b)*100}')
fi

code_total_bytes=$((rs_bytes + ts_bytes + js_bytes))
code_pct="0.000"
if [ "$code_total_bytes" -gt 0 ]; then
  code_pct=$(awk -v a="$rs_bytes" -v b="$code_total_bytes" 'BEGIN{printf "%.3f", (a/b)*100}')
fi

cat <<JSON
{
  "rust_lines": $rs_lines,
  "typescript_lines": $ts_lines,
  "javascript_lines": $js_lines,
  "repo_total_lines": $all_lines,
  "rust_repo_pct": $repo_pct,
  "rust_bytes": $rs_bytes,
  "typescript_bytes": $ts_bytes,
  "javascript_bytes": $js_bytes,
  "rust_rs_ts_js_pct": $code_pct
}
JSON
