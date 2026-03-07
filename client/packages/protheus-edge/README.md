# `@protheus/edge`

Lightweight runtime surface for mobile/edge operation:

- edge runtime (`client/systems/edge/protheus_edge_runtime.js`)
- lifecycle resilience (`client/systems/edge/mobile_lifecycle_resilience.js`)
- swarm enrollment bridge (`client/systems/spawn/mobile_edge_swarm_bridge.js`)
- wrapper distribution lane (`client/systems/ops/mobile_wrapper_distribution_pack.js`)
- benchmark matrix lane (`client/systems/ops/mobile_competitive_benchmark_matrix.js`)

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
