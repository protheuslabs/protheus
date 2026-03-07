# Settlement Program

`V4-SETTLE-001` through `V4-SETTLE-011` are implemented by:

- `client/systems/ops/settlement_program.ts`
- `client/systems/settle/settler.rs`

## CLI

```bash
node client/systems/ops/settlement_program.js settle --apply=1 --strict=1
node client/systems/ops/settlement_program.js revert --apply=1 --strict=1
node client/systems/ops/settlement_program.js edit-core --apply=1 --strict=1
node client/systems/ops/settlement_program.js edit-module --module=autonomy --apply=1 --strict=1
node client/systems/ops/settlement_program.js status
```

## Substrate Fallback Contract (`V4-SETTLE-011`)

When neither ternary nor qubit substrate is available, the runtime emits exactly:

`No ternary substrate or qubit access detected. Reverting to binary mode.`

(per settle run, unless verbose mode is enabled).
