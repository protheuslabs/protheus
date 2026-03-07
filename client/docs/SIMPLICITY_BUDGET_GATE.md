# Foundation Simplicity Budget Gate

`client/systems/ops/simplicity_budget_gate.ts` enforces complexity ceilings for the core `client/systems/` plane so architecture growth remains deliberate.

## Guarantees

- Total `client/systems/` file count and LOC budgets
- Per-organ file-count cap
- Primitive opcode-count cap
- Bespoke actuation-module cap
- New organ creation requires approved complexity-offset receipts
- Bespoke trend must stay non-increasing relative to captured baseline

## Policy

Policy file: `client/config/simplicity_budget_policy.json`

Baseline file: `client/config/simplicity_baseline.json`

Offset receipts: `state/ops/complexity_offsets.jsonl`

## Commands

```bash
# Capture baseline from current runtime shape
node client/systems/ops/simplicity_budget_gate.js capture-baseline

# Evaluate budgets (strict fail-closed)
node client/systems/ops/simplicity_budget_gate.js run --strict=1

# Read latest result
node client/systems/ops/simplicity_budget_gate.js status
```
