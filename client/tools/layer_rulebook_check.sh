#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

print_violation() {
  local title="$1"
  local file="$2"
  echo
  echo "LAYER RULE VIOLATION: ${title}"
  cat "$file"
  fail=1
}

# 1) Source code paths must live under core/ or client/ (hidden roots allowed).
bad_roots_file="$tmp_dir/bad_roots.txt"
git ls-files \
  | grep -E '\.(rs|ts|js|py|c|cc|cpp|h|hpp|html|css|sh|ps1)$' \
  | awk -F/ 'NF > 1 && $1 !~ /^(core|client|\.)$/ { print }' \
  | sort -u > "$bad_roots_file" || true
if [[ -s "$bad_roots_file" ]]; then
  print_violation "source code paths outside /core or /client" "$bad_roots_file"
fi

# 2) No client/surface languages inside core.
core_disallowed_file="$tmp_dir/core_disallowed.txt"
git ls-files 'core/**' \
  | grep -E '\.(ts|js|py|sh|ps1|html|css)$' \
  | sort > "$core_disallowed_file" || true
if [[ -s "$core_disallowed_file" ]]; then
  print_violation "non-core language files in /core" "$core_disallowed_file"
fi

# 3) No Rust/C/C++ files inside client.
client_native_file="$tmp_dir/client_native.txt"
git ls-files 'client/**' \
  | grep -E '\.(rs|c|cc|cpp|h|hpp)$' \
  | sort > "$client_native_file" || true
if [[ -s "$client_native_file" ]]; then
  print_violation "Rust/C/C++ files in /client" "$client_native_file"
fi

# 4) TS/JS pairs are only allowed when JS is a thin TS bootstrap shim.
ts_js_pairs_file="$tmp_dir/ts_js_pairs.txt"
(
  IFS='
'
  for ts in $(git ls-files '*.ts' | sort); do
    js="${ts%.ts}.js"
    if [[ -f "$js" ]]; then
      # Allowed lightweight shim:
      #   #!/usr/bin/env node
      #   'use strict';
      #   require('.../ts_bootstrap').bootstrap(__filename, module);
      filtered="$(grep -vE '^[[:space:]]*$|^#!|^[[:space:]]*["'"'"']use strict["'"'"'];[[:space:]]*$|ts_bootstrap[[:space:]]*["'"'"']\)[[:space:]]*\.bootstrap\(__filename,[[:space:]]*module\);[[:space:]]*$' "$js" || true)"
      if [[ -z "$filtered" ]] && grep -Eq "ts_bootstrap[[:space:]]*['\"]\\)[[:space:]]*\\.bootstrap\\(__filename,[[:space:]]*module\\)" "$js"; then
        continue
      fi
      printf '%s\n' "$js"
    fi
  done
) > "$ts_js_pairs_file"
if [[ -s "$ts_js_pairs_file" ]]; then
  print_violation "JS/TS duplicate pairs with non-thin JS logic" "$ts_js_pairs_file"
fi

if ((fail)); then
  exit 1
fi

echo "Layer rulebook checks passed."
