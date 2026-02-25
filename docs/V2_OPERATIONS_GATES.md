# V2 Operations Gates

Purpose: provide deterministic operational maturity controls for V2 rollout.

## 1) DR Game-Day + Release Gate

- Runner: `node systems/ops/dr_gameday.js run --strict=1`
- Cadence status: `node systems/ops/dr_gameday.js status`
- Regression gate: `node systems/ops/dr_gameday_gate.js run --strict=1`

Policy: `config/dr_gameday_policy.json`

Outputs:
- `state/ops/dr_gameday_receipts.jsonl`
- `state/ops/dr_gameday_gate_receipts.jsonl`

Gate behavior:
- Uses rolling window pass-rate + RTO/RPO regression checks.
- Fails closed when thresholds regress with sufficient sample volume.
- Marks insufficient samples explicitly without forcing false failures.

## 2) Incident Postmortem Learning Loop

CLI:
- Open: `node systems/ops/postmortem_loop.js open --incident-id=INC-001 --summary="..."`
- Add action: `node systems/ops/postmortem_loop.js add-action --incident-id=INC-001 --type=preventive --description="..." --owner=... --check-ref=...`
- Verify action: `node systems/ops/postmortem_loop.js verify-action --incident-id=INC-001 --action-id=A1 --pass=1 --evidence="..."`
- Resolve action: `node systems/ops/postmortem_loop.js resolve-action --incident-id=INC-001 --action-id=A1`
- Close: `node systems/ops/postmortem_loop.js close --incident-id=INC-001 --strict=1`

Policy: `config/postmortem_policy.json`

Guarantee:
- Preventive actions require linked checks and passing verification before closure.

## 3) Maintainer Handoff Pack + Simulation

CLI:
- Build pack: `node systems/ops/handoff_pack.js build`
- Simulate takeover: `node systems/ops/handoff_pack.js simulate --strict=1`

Policy: `config/handoff_pack_policy.json`

Outputs:
- Pack: `state/ops/handoff_pack/YYYY-MM-DD.json`
- Simulation receipts: `state/ops/handoff_simulation_receipts.jsonl`

Simulation gates:
- Critical commands pass
- SLA time not exceeded
- Required docs present
- Ownership coverage above floor

## 4) Documentation Coverage Gate

CLI:
- `node systems/ops/docs_coverage_gate.js run --strict=1`

Policy: `config/docs_coverage_map.json`

Checks:
- Critical-path changes map to required docs.
- Required docs exist.
- Optional required-doc touch mode.
- Broken local markdown links under `docs/` fail gate.

## Merge/CI Wiring

- `systems/security/merge_guard.js run` includes:
  - `docs_coverage_gate`
  - `dr_gameday_gate`
- GitHub required checks include dedicated jobs for both gates.
