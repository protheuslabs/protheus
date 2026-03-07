# NGC + NVIDIA Enterprise Distribution Adapter

`V3-RACE-278`

## Purpose

Provide a governed image/container distribution verification lane for NGC/NVIDIA AI Enterprise channels with signed provenance and rollback-safe channel controls.

## Commands

```bash
node client/systems/ops/ngc_nvidia_enterprise_distribution_adapter.js run --channel=stable --strict=1
node client/systems/ops/ngc_nvidia_enterprise_distribution_adapter.js freeze-channel --channel=stable --reason=signature_mismatch
node client/systems/ops/ngc_nvidia_enterprise_distribution_adapter.js restore-channel --channel=stable
node client/systems/ops/ngc_nvidia_enterprise_distribution_adapter.js status
```

## Verified Contracts

- Signed provenance integrity for `seed_image` and `lane_container`
- NGC registry prefix enforcement (`nvcr.io`)
- Source revision and lockfile parity across artifacts
- NVIDIA AI Enterprise profile validation and channel freeze/restore

## Policy

- `client/config/ngc_nvidia_enterprise_distribution_adapter_policy.json`
