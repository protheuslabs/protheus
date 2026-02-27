# Gated Autonomous Self-Improvement Loop (V3-038)

`systems/autonomy/gated_self_improvement_loop.ts` provides a governed self-improvement controller with staged rollout and automatic rollback.

## Flow

1. `propose` records a self-improvement proposal (`objective_id`, target path, risk).
2. `run` evaluates:
   - simulation metrics (`autonomy_simulation_harness`)
   - red-team pressure (`red_team_harness`)
3. Gate pass advances stage (`shadow -> canary -> live`).
4. Apply mode (when policy allows) runs sandbox propose/test and live merge gates.
5. Regression triggers automatic rollback receipts when sandbox linkage exists.

## Key Guarantees

- Mandatory objective binding (`require_objective_id`).
- Staged rollout, not direct live mutation.
- Gate thresholds for drift, yield, safety-stop, and red-team failure rates.
- Reversible rollback lane with immutable receipts.

## CLI

```bash
node systems/autonomy/gated_self_improvement_loop.js propose --objective-id=hardening --target-path=systems/autonomy/gated_self_improvement_loop.ts
node systems/autonomy/gated_self_improvement_loop.js run --proposal-id=<id> --apply=0
node systems/autonomy/gated_self_improvement_loop.js status
node systems/autonomy/gated_self_improvement_loop.js rollback --proposal-id=<id> --reason=manual_revert
```

