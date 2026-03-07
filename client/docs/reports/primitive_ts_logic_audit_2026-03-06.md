# Primitive TS Logic Audit (Residuals)

Date: 2026-03-06
Scope: `client/systems/primitives/*.ts` + `primitive_ts_wrapper_contract` entries

## client/systems/primitives Summary

- Total files: 8
- Direct conduit wrappers: 7
- Legacy bridge wrappers: 0
- Non-wrapper TS logic: 1

## primitive_ts_wrapper_contract Summary

- Total contract entries: 21
- Direct conduit wrappers: 21
- Legacy bridge wrappers: 0
- Non-wrapper TS logic: 0
- Missing files: 0

## Remaining Not Direct-Conduit

- client/systems/primitives/action_grammar.ts (non_wrapper_ts_logic; source=client/systems/primitives)

## Notes

- Rust remains source of truth for primitive crates; TS files listed above are residual logic or wrapper debt to migrate/deprecate.
- This report should be updated each primitive migration wave (REQ-08-005 / V6-PRIM-009).
