# Rust Spine Microkernel

`V3-RACE-034` promotes explicit Rust-spine control-plane readiness for:

- `guard`
- `spawn_broker`
- `model_router`
- `origin_lock`
- `fractal_orchestrator`

Lane entrypoint: `systems/ops/rust_spine_microkernel.js`

## Commands

```bash
node systems/ops/rust_spine_microkernel.js parity --apply=1
node systems/ops/rust_spine_microkernel.js benchmark --apply=1
node systems/ops/rust_spine_microkernel.js cutover --apply=1
node systems/ops/rust_spine_microkernel.js route --component=guard
node systems/ops/rust_spine_microkernel.js rollback --reason=manual --apply=1
node systems/ops/rust_spine_microkernel.js status
```

Cutover requires parity streak + SLO pass, and rollback forces emergency JS routing.
