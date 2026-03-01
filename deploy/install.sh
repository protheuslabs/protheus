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
exec node /Users/jay/.openclaw/workspace/systems/ops/protheusctl.js "$@"
WRAP
chmod +x "${INSTALL_DIR}/protheus"

echo "Installed protheus shim for ${TARGET} at ${INSTALL_DIR}/protheus"
