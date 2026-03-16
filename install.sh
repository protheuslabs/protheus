#!/usr/bin/env sh
set -eu

REPO_OWNER="protheuslabs"
REPO_NAME="InfRing"
DEFAULT_API="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest"
DEFAULT_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download"

INSTALL_DIR="${INFRING_INSTALL_DIR:-${PROTHEUS_INSTALL_DIR:-$HOME/.local/bin}}"
REQUESTED_VERSION="${INFRING_VERSION:-${PROTHEUS_VERSION:-latest}}"
API_URL="${INFRING_RELEASE_API_URL:-${PROTHEUS_RELEASE_API_URL:-$DEFAULT_API}}"
BASE_URL="${INFRING_RELEASE_BASE_URL:-${PROTHEUS_RELEASE_BASE_URL:-$DEFAULT_BASE}}"
INSTALL_FULL="${INFRING_INSTALL_FULL:-${PROTHEUS_INSTALL_FULL:-0}}"
INSTALL_PURE="${INFRING_INSTALL_PURE:-${PROTHEUS_INSTALL_PURE:-0}}"
INSTALL_TINY_MAX="${INFRING_INSTALL_TINY_MAX:-${PROTHEUS_INSTALL_TINY_MAX:-0}}"
INSTALL_REPAIR="${INFRING_INSTALL_REPAIR:-${PROTHEUS_INSTALL_REPAIR:-0}}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[infring install] missing required command: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd chmod
need_cmd mkdir
need_cmd uname
need_cmd tar

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

parse_install_args() {
  for arg in "$@"; do
    case "$arg" in
      --full)
        INSTALL_FULL=1
        INSTALL_PURE=0
        ;;
      --minimal)
        INSTALL_FULL=0
        ;;
      --pure)
        INSTALL_PURE=1
        INSTALL_FULL=0
        ;;
      --tiny-max)
        INSTALL_TINY_MAX=1
        INSTALL_PURE=1
        INSTALL_FULL=0
        ;;
      --repair)
        INSTALL_REPAIR=1
        ;;
      --help|-h)
        echo "Usage: install.sh [--full|--minimal|--pure|--tiny-max|--repair]"
        echo "  --full     install optional client runtime bundle when available"
        echo "  --minimal  install daemon + CLI only (default)"
        echo "  --pure     install pure Rust client + daemon only (no Node/TS surfaces)"
        echo "  --tiny-max install tiny-max pure profile for old/embedded hardware targets"
        echo "  --repair   clear stale install wrappers + workspace runtime state before install"
        exit 0
        ;;
      *)
        echo "[infring install] unknown argument: $arg" >&2
        exit 1
        ;;
    esac
  done
}

repair_install_dir() {
  for name in \
    infring infringctl infringd protheus protheusctl protheusd \
    protheus-ops protheusd-bin conduit_daemon \
    protheus-pure-workspace protheus-pure-workspace-tiny-max \
    protheus-client
  do
    target="$INSTALL_DIR/$name"
    if [ -e "$target" ]; then
      rm -rf "$target"
      echo "[infring install] repair removed stale install artifact: $target"
    fi
  done
}

resolve_workspace_root_for_repair() {
  for candidate in \
    "${INFRING_WORKSPACE_ROOT:-}" \
    "${PROTHEUS_WORKSPACE_ROOT:-}" \
    "$(pwd)" \
    "$HOME/.openclaw/workspace"
  do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/core/layer0/ops/Cargo.toml" ] && [ -d "$candidate/client/runtime" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

repair_workspace_state() {
  if ! workspace_root="$(resolve_workspace_root_for_repair)"; then
    echo "[infring install] repair skipped workspace cleanup (workspace root not detected)"
    return 0
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  archive_dir="$workspace_root/local/workspace/archive/install-repair"
  mkdir -p "$archive_dir"

  if [ -d "$workspace_root/local/workspace/memory" ]; then
    tar -czf "$archive_dir/memory-$ts.tgz" -C "$workspace_root/local/workspace" memory >/dev/null 2>&1 || true
    echo "[infring install] repair archived local/workspace/memory to $archive_dir/memory-$ts.tgz"
  fi
  if [ -d "$workspace_root/local/state" ]; then
    tar -czf "$archive_dir/state-$ts.tgz" -C "$workspace_root/local" state >/dev/null 2>&1 || true
    echo "[infring install] repair archived local/state to $archive_dir/state-$ts.tgz"
  fi

  for rel in client/runtime/local client/tmp core/local/tmp local/state; do
    abs="$workspace_root/$rel"
    if [ -e "$abs" ]; then
      rm -rf "$abs"
      echo "[infring install] repair removed stale runtime path: $rel"
    fi
  done
  mkdir -p "$workspace_root/local/state"
}

norm_os() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux) echo "linux" ;;
    darwin) echo "darwin" ;;
    *)
      echo "[infring install] unsupported OS: $os" >&2
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
      echo "[infring install] unsupported architecture: $arch" >&2
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
    echo "[infring install] failed to resolve latest release tag from GitHub API" >&2
    exit 1
  fi
  echo "$version"
}

download_asset() {
  version_tag="$1"
  asset_name="$2"
  asset_out="$3"
  url="$BASE_URL/$version_tag/$asset_name"
  # TODO(rk): Consider adding retry logic with exponential backoff for transient network failures.
  # This would improve install reliability in CI environments and regions with intermittent connectivity.
  if curl -fsSL "$url" -o "$asset_out"; then
    echo "[infring install] downloaded $asset_name"
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

  if download_asset "$version_tag" "${stem_name}" "$tmpdir/$stem_name"; then
    mv "$tmpdir/$stem_name" "$binary_out"
    chmod 755 "$binary_out"
    rm -rf "$tmpdir"
    return 0
  fi

  if download_asset "$version_tag" "${stem_name}.bin" "$tmpdir/$stem_name"; then
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

install_client_bundle() {
  version_tag="$1"
  triple_id="$2"
  output_dir="$3"

  tmpdir="$(mktemp -d)"
  mkdir -p "$output_dir"
  archive="$tmpdir/client-runtime.bundle"

  extract_bundle() {
    archive_path="$1"
    case "$archive_path" in
      *.tar.zst)
        if command -v unzstd >/dev/null 2>&1; then
          unzstd -c "$archive_path" | tar -xf - -C "$output_dir"
          return $?
        fi
        if command -v zstd >/dev/null 2>&1; then
          zstd -dc "$archive_path" | tar -xf - -C "$output_dir"
          return $?
        fi
        echo "[infring install] skipping .tar.zst bundle (zstd not installed); falling back to .tar.gz assets"
        return 1
        ;;
      *.tar.gz)
        tar -xzf "$archive_path" -C "$output_dir"
        return $?
        ;;
      *)
        return 1
        ;;
    esac
  }

  for asset in \
    "protheus-client-runtime-${triple_id}.tar.zst" \
    "protheus-client-runtime.tar.zst" \
    "protheus-client-${triple_id}.tar.zst" \
    "protheus-client.tar.zst" \
    "protheus-client-runtime-${triple_id}.tar.gz" \
    "protheus-client-runtime.tar.gz" \
    "protheus-client-${triple_id}.tar.gz" \
    "protheus-client.tar.gz"
  do
    if download_asset "$version_tag" "$asset" "$archive"; then
      if extract_bundle "$archive"; then
        rm -rf "$tmpdir"
        echo "[infring install] installed optional client runtime bundle"
        return 0
      fi
    fi
  done

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
  parse_install_args "$@"

  mkdir -p "$INSTALL_DIR"
  if is_truthy "$INSTALL_REPAIR"; then
    echo "[infring install] repair mode enabled"
    repair_install_dir
    repair_workspace_state
  fi
  triple="$(platform_triple)"
  version="$(resolve_version)"

  echo "[infring install] version: $version"
  echo "[infring install] platform: $triple"
  echo "[infring install] install dir: $INSTALL_DIR"

  ops_bin="$INSTALL_DIR/protheus-ops"
  pure_bin="$INSTALL_DIR/protheus-pure-workspace"
  protheusd_bin="$INSTALL_DIR/protheusd-bin"
  daemon_bin="$INSTALL_DIR/conduit_daemon"
  daemon_wrapper_body=""
  prefer_musl_protheusd=0

  if [ "$(norm_os)" = "linux" ] && [ "$(norm_arch)" = "x86_64" ]; then
    prefer_musl_protheusd=1
  fi

  if is_truthy "$INSTALL_PURE"; then
    if is_truthy "$INSTALL_TINY_MAX"; then
      if ! install_binary "$version" "$triple" "protheus-pure-workspace-tiny-max" "$pure_bin"; then
        if ! install_binary "$version" "$triple" "protheus-pure-workspace" "$pure_bin"; then
          echo "[infring install] failed to fetch protheus-pure-workspace for $triple ($version)" >&2
          exit 1
        fi
      fi
    elif ! install_binary "$version" "$triple" "protheus-pure-workspace" "$pure_bin"; then
      echo "[infring install] failed to fetch protheus-pure-workspace for $triple ($version)" >&2
      exit 1
    fi
    if is_truthy "$INSTALL_TINY_MAX"; then
      echo "[infring install] tiny-max pure mode selected: Rust-only tiny profile installed"
    else
      echo "[infring install] pure mode selected: Rust-only client installed"
    fi
  else
    if ! install_binary "$version" "$triple" "protheus-ops" "$ops_bin"; then
      echo "[infring install] failed to fetch protheus-ops for $triple ($version)" >&2
      exit 1
    fi
  fi

  if [ "$prefer_musl_protheusd" = "1" ]; then
    if is_truthy "$INSTALL_TINY_MAX"; then
      if install_binary "$version" "x86_64-unknown-linux-musl" "protheusd-tiny-max" "$protheusd_bin"; then
        daemon_wrapper_body="exec \"$protheusd_bin\" \"\$@\""
        echo "[infring install] using static musl tiny-max protheusd"
      fi
    fi
    if [ -z "$daemon_wrapper_body" ] && install_binary "$version" "x86_64-unknown-linux-musl" "protheusd" "$protheusd_bin"; then
      daemon_wrapper_body="exec \"$protheusd_bin\" \"\$@\""
      echo "[infring install] using static musl protheusd (embedded-minimal-core)"
    fi
  fi

  if [ -z "$daemon_wrapper_body" ] && is_truthy "$INSTALL_TINY_MAX"; then
    if install_binary "$version" "$triple" "protheusd-tiny-max" "$protheusd_bin"; then
      daemon_wrapper_body="exec \"$protheusd_bin\" \"\$@\""
      echo "[infring install] using native tiny-max protheusd"
    fi
  fi

  if [ -z "$daemon_wrapper_body" ] && install_binary "$version" "$triple" "protheusd" "$protheusd_bin"; then
    daemon_wrapper_body="exec \"$protheusd_bin\" \"\$@\""
    echo "[infring install] using native protheusd"
  fi

  if [ -z "$daemon_wrapper_body" ] && install_binary "$version" "$triple" "conduit_daemon" "$daemon_bin"; then
    daemon_wrapper_body="exec \"$daemon_bin\" \"\$@\""
    echo "[infring install] using conduit_daemon compatibility fallback"
  else
    if [ -z "$daemon_wrapper_body" ]; then
      echo "[infring install] no dedicated daemon binary found; falling back to protheus-ops spine mode"
    fi
  fi

  if is_truthy "$INSTALL_PURE"; then
    if is_truthy "$INSTALL_TINY_MAX"; then
      write_wrapper "infring" "exec \"$pure_bin\" --tiny-max=1 \"\$@\""
    else
      write_wrapper "infring" "exec \"$pure_bin\" \"\$@\""
    fi
    write_wrapper "infringctl" "exec \"$pure_bin\" conduit \"\$@\""
  else
    write_wrapper "infring" "exec \"$ops_bin\" protheusctl \"\$@\""
    write_wrapper "infringctl" "exec \"$ops_bin\" protheusctl \"\$@\""
  fi

  if [ -n "$daemon_wrapper_body" ]; then
    write_wrapper "infringd" "$daemon_wrapper_body"
  else
    if is_truthy "$INSTALL_PURE"; then
      echo "[infring install] no daemon binary available for pure mode" >&2
      exit 1
    fi
    write_wrapper "infringd" "exec \"$ops_bin\" spine \"\$@\""
  fi

  write_wrapper "protheus" "echo \"[deprecation] 'protheus' is deprecated; use 'infring'.\" >&2; exec \"$INSTALL_DIR/infring\" \"\$@\""
  write_wrapper "protheusctl" "exec \"$INSTALL_DIR/infringctl\" \"\$@\""
  write_wrapper "protheusd" "echo \"[deprecation] 'protheusd' is deprecated; use 'infringd'.\" >&2; exec \"$INSTALL_DIR/infringd\" \"\$@\""

  if is_truthy "$INSTALL_PURE"; then
    echo "[infring install] pure mode: skipping OpenClaw client bundle"
  elif is_truthy "$INSTALL_FULL"; then
    client_dir="$INSTALL_DIR/protheus-client"
    if install_client_bundle "$version" "$triple" "$client_dir"; then
      echo "[infring install] full mode enabled: client runtime installed at $client_dir"
    else
      echo "[infring install] full mode requested but no client runtime bundle was published for this release"
    fi
  else
    echo "[infring install] lazy mode: skipping TS systems/eyes client bundle (use --full to include)"
  fi

  echo "[infring install] installed: infring, infringctl, infringd"
  echo "[infring install] aliases: protheus, protheusctl, protheusd"
  echo "[infring install] run: infring --help"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      ;;
    *)
      echo "[infring install] add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac
}

main "$@"
