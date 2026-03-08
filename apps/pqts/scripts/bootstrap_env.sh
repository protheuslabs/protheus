#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
USE_LOCK=0
SKIP_DEV=0

usage() {
  cat <<'USAGE'
Bootstrap PQTS local environment.

Usage:
  scripts/bootstrap_env.sh [--python /path/to/python] [--venv /path/to/venv] [--lock] [--skip-dev]

Options:
  --python PATH   Python interpreter to use (default: python3)
  --venv PATH     Virtualenv directory (default: .venv in repo root)
  --lock          Install with requirements.lock using --require-hashes
  --skip-dev      Install runtime dependencies only (skip black/isort/ruff/flake8/mypy/bandit)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)
      PYTHON_BIN="$2"
      shift 2
      ;;
    --venv)
      VENV_DIR="$2"
      shift 2
      ;;
    --lock)
      USE_LOCK=1
      shift
      ;;
    --skip-dev)
      SKIP_DEV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

echo "[bootstrap] root=${ROOT_DIR}"
echo "[bootstrap] python=${PYTHON_BIN}"
echo "[bootstrap] venv=${VENV_DIR}"

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

"${VENV_PY}" -m pip install --upgrade pip

if [[ "${USE_LOCK}" -eq 1 ]]; then
  echo "[bootstrap] installing strict lockfile dependencies"
  "${VENV_PIP}" install --require-hashes -r "${ROOT_DIR}/requirements.lock"
else
  echo "[bootstrap] installing requirements.txt dependencies"
  if [[ "${SKIP_DEV}" -eq 1 ]]; then
    "${VENV_PIP}" install -r "${ROOT_DIR}/requirements.txt"
  else
    "${VENV_PIP}" install -r "${ROOT_DIR}/requirements.txt"
  fi
fi

echo "[bootstrap] done"
echo "[bootstrap] activate with: source ${VENV_DIR}/bin/activate"

