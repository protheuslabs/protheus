# Mobile Wrapper Distribution Pack

This contract lane provides signed wrapper distribution artifacts for mobile targets.

Targets:

- `android_termux`
- `ios_tauri`

Core commands:

```bash
node client/runtime/systems/ops/mobile_wrapper_distribution_pack.ts build --owner=operator --target=android_termux --version=0.1.0
node client/runtime/systems/ops/mobile_wrapper_distribution_pack.ts verify --owner=operator --target=android_termux --strict=1
node client/runtime/systems/ops/mobile_wrapper_distribution_pack.ts rollback --owner=operator --target=android_termux --reason=manual_gate
```

Wrappers are distributed from:

- `packages/protheus-edge/wrappers/android_termux`
- `packages/protheus-edge/wrappers/ios_tauri`

Each build emits deterministic receipts and signed bundle hashes in:

- `state/edge/mobile_wrapper_distribution/manifest.json`
