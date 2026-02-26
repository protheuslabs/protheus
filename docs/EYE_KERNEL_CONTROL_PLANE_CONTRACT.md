# Eye Kernel Control-Plane Contract (RM-101)

Date: 2026-02-26  
Scope: `systems/eye/eye_kernel.ts`

## Purpose

Provides a unified policy-gated command bus that decides whether a lane route is `allow`, `escalate`, or `deny` using:
- lane/action/target allowlists
- clearance envelopes
- risk gating
- global and per-lane daily token budgets

## Commands

```bash
node systems/eye/eye_kernel.js route --lane=<lane> --target=<target> --action=<action> [--risk=low|medium|high|critical] [--clearance=L0|L1|L2|L3] [--estimated-tokens=N] [--apply=1|0]
node systems/eye/eye_kernel.js status [--date=YYYY-MM-DD]
```

## Policy Contract

`config/eye_kernel_policy.json` defines:
- `clearance_levels[]`
- `risk.escalate[]` and `risk.deny[]`
- `budgets.global_daily_tokens`
- `lanes.<lane>`:
  - `enabled`
  - `min_clearance`
  - `daily_tokens`
  - `actions[]`
  - `targets[]`

## State and Receipts

- State: `state/eye/control_plane_state.json`
- Audit log: `state/eye/audit/command_bus.jsonl`
- Latest decision snapshot: `state/eye/latest.json`

Route receipts include:
- request envelope (`lane`, `target`, `action`, `risk`, `clearance`, `estimated_tokens`)
- decision (`allow|escalate|deny`)
- reasons array
- policy version
- apply mode + day partition

## Tests

- `memory/tools/tests/eye_kernel.test.js`

