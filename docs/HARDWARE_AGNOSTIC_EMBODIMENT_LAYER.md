# Hardware-Agnostic Embodiment Layer

`systems/hardware/embodiment_layer.ts` provides a unified capability + surface-budget contract so core runtime lanes can stay hardware-neutral.

## Guarantees

- Stable embodiment contract for phone/desktop/cluster profiles
- Surface-budget scoring from hardware/sensor inputs
- Capability envelope projection (parallelism, inversion depth, dream intensity)
- Cross-profile parity verification for non-capacity invariants
- Receipted snapshots and parity checks

## Policy

Policy file: `config/embodiment_layer_policy.json`

Outputs:

- Latest snapshot: `state/hardware/embodiment/latest.json`
- Receipts: `state/hardware/embodiment/receipts.jsonl`

## Commands

```bash
# Measure and persist embodiment snapshot
node systems/hardware/embodiment_layer.js sense --profile=auto

# Verify profile parity invariants (ignoring configured capacity fields)
node systems/hardware/embodiment_layer.js verify-parity --profiles=phone,desktop,cluster --strict=1

# Read latest snapshot
node systems/hardware/embodiment_layer.js status
```

Runtime lanes can consume latest embodiment state instead of direct hardware probes.
