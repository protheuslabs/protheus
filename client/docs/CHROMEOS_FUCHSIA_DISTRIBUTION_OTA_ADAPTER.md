# ChromeOS/Fuchsia Distribution OTA Adapter

`V3-RACE-273`

## Purpose

Provide a governed distribution and OTA verification lane for ChromeOS and Fuchsia package channels with deterministic rollback controls.

## Commands

```bash
node client/systems/ops/chromeos_fuchsia_distribution_ota_adapter.js run --channel=chromeos-stable --strict=1
node client/systems/ops/chromeos_fuchsia_distribution_ota_adapter.js freeze-channel --channel=chromeos-stable --reason=integrity_drift
node client/systems/ops/chromeos_fuchsia_distribution_ota_adapter.js restore-channel --channel=chromeos-stable
node client/systems/ops/chromeos_fuchsia_distribution_ota_adapter.js status
```

## Verified Contracts

- Package signature integrity for `chromeos` and `fuchsia` targets
- Build revision parity across channels
- OTA staged rollout plan completeness (`5/25/50/100`)
- Rollback window minimums and freeze/restore controls

## Policy

- `client/config/chromeos_fuchsia_distribution_ota_adapter_policy.json`
