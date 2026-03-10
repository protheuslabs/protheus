# protheus-cli-wrapper

Thin Python entrypoint for Protheus.

This package does not re-implement kernel logic. It only forwards CLI arguments to the Rust `protheus-ops` runtime.

## Install

```bash
pip install protheus-cli-wrapper
```

From this repository:

```bash
pip install ./packages/protheus-py
```

## Usage

```bash
protheus --help
protheus status --dashboard
```

## Runtime Resolution Order

1. `PROTHEUS_OPS_BIN` (if set)
2. `protheus-ops` on `PATH`
3. Local repo binaries:
   - `target/release/protheus-ops`
   - `target/debug/protheus-ops`
4. Cargo fallback:
   - `cargo run --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- ...`
