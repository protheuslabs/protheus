# Type-Derived Lane Docs Autogeneration

`V3-RACE-230` keeps lane docs in sync with TS/Rust type surfaces and blocks stale documentation.

## Commands

```bash
node client/systems/ops/type_derived_lane_docs_autogen.js generate --apply=1 --strict=1
node client/systems/ops/type_derived_lane_docs_autogen.js verify --strict=1
node client/systems/ops/type_derived_lane_docs_autogen.js rollback --apply=1
```

## Outputs

- `client/docs/generated/TS_LANE_TYPE_REFERENCE.md`
- `client/docs/generated/RUST_LANE_TYPE_REFERENCE.md`

The lane writes receipts and rollback snapshots under `state/ops/type_derived_lane_docs_autogen/`.
