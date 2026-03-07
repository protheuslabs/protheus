# Help

## Common Commands

- `npm run build` -> compile/check baseline
- `npm run test` -> run stable test suite
- `node client/systems/ops/backlog_registry.js triage` -> inspect ready queue
- `node client/systems/ops/docs_surface_contract.js check --strict=1` -> verify docs contract
- `node client/systems/ops/root_surface_contract.js check --strict=1` -> verify root surface contract

## Troubleshooting

- If a lane returns `unknown_command`, run with `--help`.
- If strict checks fail, inspect `state/ops/.../latest.json` artifacts for blocking checks.
- If docs checks fail, run the client/docs/DX verifier:
  - `node client/systems/ops/public_docs_developer_experience_overhaul.js verify --strict=1`

## Escalation

- Runtime regression: `client/docs/OPERATOR_RUNBOOK.md`
- Governance mismatch: `client/docs/BACKLOG_GOVERNANCE.md`
- Security concerns: `SECURITY.md`
