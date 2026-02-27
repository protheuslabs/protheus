# Surface Budget Controller

`RM-125` introduces a sensor-driven budget controller that maps hardware pressure into explicit runtime lane caps.

## Commands

```bash
node systems/hardware/surface_budget_controller.js run
node systems/hardware/surface_budget_controller.js run --apply=1 --strict=1
node systems/hardware/surface_budget_controller.js status
```

## Policy

Policy file: `config/surface_budget_controller_policy.json`

Key controls:
- Tiered budget envelopes (`critical`, `low`, `balanced`, `high`)
- Allowed scheduler modes by tier
- Caps for inversion depth, dream intensity, right-brain ratio, and fractal breadth
- Minimum transition cadence to prevent mode thrash

## Enforcement

- Emits deterministic receipts to `state/hardware/surface_budget/receipts.jsonl`
- Stores latest evaluation in `state/hardware/surface_budget/latest.json`
- `runtime_scheduler` enforces `allow_modes` and denies blocked transitions with `surface_budget_mode_block`
- Optional `--apply=1` can force runtime mode downgrade when current mode violates budget tier
