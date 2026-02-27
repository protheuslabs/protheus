# Phone Seed Profile

`RM-124` defines a bounded viability gate for the phone-seed runtime profile.

## Commands

```bash
node systems/ops/phone_seed_profile.js run
node systems/ops/phone_seed_profile.js run --strict=1
node systems/ops/phone_seed_profile.js status
```

## Policy

Policy file: `config/phone_seed_profile_policy.json`

Key controls:
- Boot target (`boot_ms_max`, default `800`)
- Idle RSS target (`idle_rss_mb_max`, default `180`)
- Workflow + memory latency targets (default `3000ms` each)
- Required heavy-lane disable check via embodiment snapshot

## State

- Latest status: `state/ops/phone_seed_profile/status.json`
- History: `state/ops/phone_seed_profile/history.jsonl`

Outputs include:
- pass/fail checks per threshold
- sampled boot probe metrics (`boot_ms`, `rss_mb`)
- workflow/memory latency probe results
- embodiment snapshot gate (`heavy_lanes_disabled`)
