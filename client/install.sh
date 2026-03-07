#!/usr/bin/env sh
set -eu

REPO_OWNER="protheuslabs"
REPO_NAME="protheus"
DEFAULT_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
DEFAULT_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"

INSTALL_DIR="${PROTHEUS_INSTALL_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${PROTHEUS_VERSION:-latest}"
API_URL="${PROTHEUS_RELEASE_API_URL:-$DEFAULT_API}"
BASE_URL="${PROTHEUS_RELEASE_BASE_URL:-$DEFAULT_BASE}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[protheus install] missing required command: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd chmod
need_cmd mkdir
need_cmd uname

norm_os() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux) echo "linux" ;;
    darwin) echo "darwin" ;;
    *)
      echo "[protheus install] unsupported OS: $os" >&2
      exit 1
      ;;
  esac
}

norm_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) echo "x86_64" ;;
    arm64|aarch64) echo "aarch64" ;;
    *)
      echo "[protheus install] unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac
}

platform_triple() {
  os="$(norm_os)"
  arch="$(norm_arch)"
  case "$os" in
    linux) echo "${arch}-unknown-linux-gnu" ;;
    darwin) echo "${arch}-apple-darwin" ;;
  esac
}

latest_version() {
  curl -fsSL "$API_URL" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

resolve_version() {
  if [ "$REQUESTED_VERSION" != "latest" ]; then
    case "$REQUESTED_VERSION" in
      v*) echo "$REQUESTED_VERSION" ;;
      *) echo "v$REQUESTED_VERSION" ;;
    esac
    return
  fi

  version="$(latest_version || true)"
  if [ -z "$version" ]; then
    echo "[protheus install] failed to resolve latest release tag from GitHub API" >&2
    exit 1
  fi
  echo "$version"
}

download_asset() {
  version_tag="$1"
  asset_name="$2"
  asset_out="$3"
  url="$BASE_URL/$version_tag/$asset_name"
  if curl -fsSL "$url" -o "$asset_out"; then
    echo "[protheus install] downloaded $asset_name"
    return 0
  fi
  return 1
}

install_binary() {
  version_tag="$1"
  triple_id="$2"
  stem_name="$3"
  binary_out="$4"

  tmpdir="$(mktemp -d)"
  if download_asset "$version_tag" "${stem_name}-${triple_id}" "$tmpdir/$stem_name"; then
    mv "$tmpdir/$stem_name" "$binary_out"
    chmod 755 "$binary_out"
    rm -rf "$tmpdir"
    return 0
  fi

  if download_asset "$version_tag" "${stem_name}-${triple_id}.bin" "$tmpdir/$stem_name"; then
    mv "$tmpdir/$stem_name" "$binary_out"
    chmod 755 "$binary_out"
    rm -rf "$tmpdir"
    return 0
  fi

  if download_asset "$version_tag" "${stem_name}-${triple_id}.tar.gz" "$tmpdir/${stem_name}.tar.gz"; then
    tar -xzf "$tmpdir/${stem_name}.tar.gz" -C "$tmpdir"
    if [ -f "$tmpdir/$stem_name" ]; then
      mv "$tmpdir/$stem_name" "$binary_out"
      chmod 755 "$binary_out"
      rm -rf "$tmpdir"
      return 0
    fi
  fi

  rm -rf "$tmpdir"
  return 1
}

write_wrapper() {
  wrapper_name="$1"
  wrapper_body="$2"
  wrapper_path="$INSTALL_DIR/$wrapper_name"
  printf '%s\n' "#!/usr/bin/env sh" > "$wrapper_path"
  printf '%s\n' "$wrapper_body" >> "$wrapper_path"
  chmod 755 "$wrapper_path"
}

main() {
  mkdir -p "$INSTALL_DIR"
  triple="$(platform_triple)"
  version="$(resolve_version)"

  echo "[protheus install] version: $version"
  echo "[protheus install] platform: $triple"
  echo "[protheus install] install dir: $INSTALL_DIR"

  ops_bin="$INSTALL_DIR/protheus-ops"
  daemon_bin="$INSTALL_DIR/conduit_daemon"

  if ! install_binary "$version" "$triple" "protheus-ops" "$ops_bin"; then
    echo "[protheus install] failed to fetch protheus-ops for $triple ($version)" >&2
    exit 1
  fi

  if ! install_binary "$version" "$triple" "conduit_daemon" "$daemon_bin"; then
    echo "[protheus install] conduit_daemon not found in release; skipping daemon binary"
    daemon_bin=""
  fi

  write_wrapper "protheus" "exec \"$ops_bin\" protheusctl \"\$@\""
  write_wrapper "protheusctl" "exec \"$ops_bin\" protheusctl \"\$@\""

  if [ -n "$daemon_bin" ]; then
    write_wrapper "protheusd" "exec \"$daemon_bin\" \"\$@\""
  else
    write_wrapper "protheusd" "exec \"$ops_bin\" spine \"\$@\""
  fi

  echo "[protheus install] installed: protheus, protheusctl, protheusd"
  echo "[protheus install] run: protheus --help"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      ;;
    *)
      echo "[protheus install] add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
}

main "$@"
