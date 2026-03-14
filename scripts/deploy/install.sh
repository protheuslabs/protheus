#!/usr/bin/env bash
set -euo pipefail

# Deterministic one-line installer scaffold (V3-DEP-001).
# Production artifact resolution is policy-gated and can be swapped without changing UX.

OS="$(uname | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
TARGET="${OS}-${ARCH}"

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "${INSTALL_DIR}"

cat > "${INSTALL_DIR}/protheus" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail

if command -v protheus-ops >/dev/null 2>&1; then
  exec protheus-ops protheusctl "$@"
fi

WORKSPACE="${OPENCLAW_WORKSPACE:-${PROTHEUS_WORKSPACE:-$HOME/.openclaw/workspace}}"
CLI="${WORKSPACE}/client/cli/bin/protheusctl"
if [ -f "${CLI}" ]; then
  exec node "${CLI}" "$@"
fi

echo "protheus installer shim could not find a runnable backend." >&2
echo "Set OPENCLAW_WORKSPACE or install protheus-ops in PATH." >&2
exit 1
WRAP
chmod +x "${INSTALL_DIR}/protheus"

echo "Installed protheus shim for ${TARGET} at ${INSTALL_DIR}/protheus"
