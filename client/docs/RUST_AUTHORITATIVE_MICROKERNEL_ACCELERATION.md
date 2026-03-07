# Rust Authoritative Microkernel Acceleration

`V4-RUST-001` orchestrates the Rust-first cutover checks and publishes tracked-source language composition.

## Commands

```bash
node client/systems/ops/rust_authoritative_microkernel_acceleration.js run --strict=1 --apply=1
node client/systems/ops/rust_authoritative_microkernel_acceleration.js report
node client/systems/ops/rust_authoritative_microkernel_acceleration.js status
```

## What It Runs

- `rust_spine_microkernel` parity/benchmark/cutover
- `wasi2_execution_completeness_gate`
- `execution_sandbox_rust_wasm_coprocessor_lane` verify

## Language Report

Writes `state/ops/rust_authoritative_microkernel_acceleration/language_report.json` with:

- `.rs/.ts/.js` tracked-source byte composition
- current Rust share percentage
- target window (`55-65%`) and bytes required to reach minimum target
