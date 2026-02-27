# Foundation Simplicity Budget Gate

`systems/ops/simplicity_budget_gate.ts` enforces complexity ceilings for the core `systems/` plane so architecture growth remains deliberate.

## Guarantees

- Total `systems/` file count and LOC budgets
- Per-organ file-count cap
- Primitive opcode-count cap
- Bespoke actuation-module cap
- New organ creation requires approved complexity-offset receipts
- Bespoke trend must stay non-increasing relative to captured baseline

## Policy

Policy file: `config/simplicity_budget_policy.json`

Baseline file: `config/simplicity_baseline.json`

Offset receipts: `state/ops/complexity_offsets.jsonl`

## Commands

```bash
# Capture baseline from current runtime shape
node systems/ops/simplicity_budget_gate.js capture-baseline

# Evaluate budgets (strict fail-closed)
node systems/ops/simplicity_budget_gate.js run --strict=1

# Read latest result
node systems/ops/simplicity_budget_gate.js status
```
