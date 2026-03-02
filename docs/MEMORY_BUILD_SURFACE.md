# Memory Build Surface Compatibility

Generated: 2026-03-02T02:39:57.806Z

Default runtime transport: `daemon_first`

| Profile | Role | Run Command |
|---|---|---|
| daemon_first | production_default | `node systems/memory/memory_recall.js query --q="probe" --top=1` |
| napi_optional | performance_optional | `MEMORY_RECALL_RUST_NAPI_ENABLED=1 node systems/memory/memory_recall.js query --q="probe" --top=1` |
| cli_compat | legacy_compat | `cargo run --manifest-path systems/memory/rust/Cargo.toml -- query-index --q probe --root=.` |

## Build Checks

- Rust build ok: yes
- Rust probe ok: yes
- Daemon-first default enforced: yes

