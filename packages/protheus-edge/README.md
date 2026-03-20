# `@protheus/edge`

Lightweight runtime surface for mobile/edge operation:

- edge runtime (`client/runtime/systems/edge/protheus_edge_runtime.ts`)
- lifecycle resilience (`client/runtime/systems/edge/mobile_lifecycle_resilience.ts`)
- swarm enrollment bridge (`client/runtime/systems/spawn/mobile_edge_swarm_bridge.ts`)
- wrapper distribution lane (`client/runtime/systems/ops/mobile_wrapper_distribution_pack.ts`)
- benchmark matrix lane (`client/runtime/systems/ops/run_protheus_ops.js` + `benchmark-matrix`)

Quick start:

```bash
node packages/protheus-edge/starter.js --mode=status
```

Contract check:

```bash
node packages/protheus-edge/starter.js --mode=contract --max-mb=5 --max-ms=200
```

Wrapper directories:

- `packages/protheus-edge/wrappers/android_termux`
- `packages/protheus-edge/wrappers/ios_tauri`
