#!/usr/bin/env bash
set -euo pipefail

CSV=""
APPLY=0
COMMIT_REF="HEAD"
I_UNDERSTAND=0
OUT_DIR="local/state/ops/evidence"

for arg in "$@"; do
  case "$arg" in
    --csv=*) CSV="${arg#*=}" ;;
    --apply) APPLY=1 ;;
    --commit=*) COMMIT_REF="${arg#*=}" ;;
    --out-dir=*) OUT_DIR="${arg#*=}" ;;
    --i-understand-history-rewrite=1) I_UNDERSTAND=1 ;;
    --help|-h)
      cat <<USAGE
Usage: scripts/empty_fort_coauthor_inject.sh --csv=<path> [--apply] [--commit=HEAD] [--out-dir=local/state/ops/evidence] [--i-understand-history-rewrite=1]

Expected CSV headers:
  github_username,email,consent_token

Dry-run is default. --apply requires --i-understand-history-rewrite=1.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CSV" ]]; then
  echo "Missing required --csv=<path>" >&2
  exit 1
fi

if [[ "$APPLY" -eq 1 && "$I_UNDERSTAND" -ne 1 ]]; then
  echo "Refusing apply without --i-understand-history-rewrite=1" >&2
  exit 1
fi

if [[ ! -f "$CSV" ]]; then
  echo "CSV not found: $CSV" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TRAILERS_FILE="$OUT_DIR/empty_fort_coauthors_${TS}.txt"
RECEIPT_FILE="$OUT_DIR/empty_fort_coauthors_${TS}.json"

python3 - "$CSV" "$TRAILERS_FILE" "$RECEIPT_FILE" <<'PY'
import csv, json, re, sys
from pathlib import Path

csv_path = Path(sys.argv[1])
trailers_path = Path(sys.argv[2])
receipt_path = Path(sys.argv[3])

with csv_path.open(newline='', encoding='utf-8') as f:
    rows = list(csv.DictReader(f))

required = {'github_username', 'email', 'consent_token'}
if not rows:
    raise SystemExit('CSV has no data rows')
if set(rows[0].keys()) < required:
    raise SystemExit('CSV headers must include github_username,email,consent_token')

uname_re = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$')
email_re = re.compile(r'^[^@\s]+@users\.noreply\.github\.com$')

seen=set()
lines=[]
for row in rows:
    username=(row.get('github_username') or '').strip()
    email=(row.get('email') or '').strip()
    consent=(row.get('consent_token') or '').strip()
    if not username or not uname_re.match(username):
        raise SystemExit(f'invalid github_username: {username or "<empty>"}')
    if not email or not email_re.match(email):
        raise SystemExit(f'invalid github noreply email: {email or "<empty>"}')
    if not consent:
        raise SystemExit(f'missing consent_token for github_username={username}')
    key=(username.lower(), email.lower())
    if key in seen:
        continue
    seen.add(key)
    lines.append(f'Co-authored-by: {username} <{email}>')

lines.sort()
trailers_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
receipt = {
    'ok': True,
    'source_csv': str(csv_path),
    'trailers_file': str(trailers_path),
    'count': len(lines),
}
receipt_path.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt, indent=2))
PY

if [[ "$APPLY" -eq 0 ]]; then
  echo "Dry-run complete. Trailers written to: $TRAILERS_FILE"
  exit 0
fi

BASE_MESSAGE="$(git log -1 --pretty=%B "$COMMIT_REF")"
NEW_MESSAGE="${BASE_MESSAGE}"
while IFS= read -r trailer; do
  if [[ -n "$trailer" ]]; then
    if ! grep -Fq "$trailer" <<<"$NEW_MESSAGE"; then
      NEW_MESSAGE+=$'\n'
      NEW_MESSAGE+="$trailer"
    fi
  fi
done < "$TRAILERS_FILE"

if [[ "$COMMIT_REF" != "HEAD" ]]; then
  echo "Apply mode currently supports --commit=HEAD only." >&2
  exit 1
fi

git commit --amend -m "$NEW_MESSAGE" >/dev/null

echo "Applied co-author trailers to $COMMIT_REF from $TRAILERS_FILE"
