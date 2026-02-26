# Compliance Reports

`systems/ops/compliance_reports.js` produces machine-checkable control evidence and readiness reports.

## Commands

```bash
node systems/ops/compliance_reports.js evidence-index --days=30
node systems/ops/compliance_reports.js control-inventory
node systems/ops/compliance_reports.js framework-readiness --framework=all --days=30 --strict=0
node systems/ops/compliance_reports.js soc2-readiness --days=30 --strict=0
node systems/ops/compliance_reports.js status
```

## Framework Coverage

Control policy (`config/compliance_controls_map.json`) now maps controls to:

- `soc2`
- `iso27001`
- `nist_ai_rmf`

Each control carries:

- `owner`
- `frequency`
- `frameworks`
- `evidence` rules with machine-evaluated pass/fail output

## Output Artifacts

Per day:

- `state/ops/compliance/YYYY-MM-DD/evidence_index.json`
- `state/ops/compliance/YYYY-MM-DD/control_inventory.json`
- `state/ops/compliance/YYYY-MM-DD/framework_readiness.json`
- `state/ops/compliance/YYYY-MM-DD/soc2_readiness.json`

History:

- `state/ops/compliance/history.jsonl`

