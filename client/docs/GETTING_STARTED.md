# Getting Started

Protheus runs with a Rust core and a thin TypeScript surface routed through conduit.

## 1) Install in <2 minutes

### macOS / Linux

```bash
curl -fsSL https://get.protheus.ai/install | sh
```

Fallback (direct repo script):

```bash
curl -fsSL https://raw.githubusercontent.com/protheuslabs/protheus/main/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/protheuslabs/protheus/main/install.ps1 | iex
```

### Optional: Python Wrapper (`pip install`)

```bash
pip install protheus-cli-wrapper
protheus --help
```

## 2) Verify binaries

```bash
protheus --help
protheusctl --help
protheusd --help
```

## 3) Start core surfaces

```bash
protheusd
protheus status
protheus contract-check
```

## 4) Run mandatory gates

```bash
cargo run --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- contract-check
NODE_PATH=$PWD/node_modules npm run -s formal:invariants:run
```

## Notes

- Rust is the source of truth for kernel logic (primitives, constitution, policy, receipts).
- TypeScript is limited to thin client surfaces and extension/UI workflows via conduit.
- Python is optional and only provides a thin CLI wrapper that forwards to Rust.
- If `get.protheus.ai` is not yet wired in your environment, use the raw GitHub fallback command above.
