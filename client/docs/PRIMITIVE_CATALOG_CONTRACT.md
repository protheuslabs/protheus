# Primitive Catalog Contract (`V3-042`)

The primitive catalog is the mandatory execution grammar contract.

## Contract Files

- `client/config/primitive_catalog.json`
- `client/config/primitive_migration_contract.json`
- `client/systems/ops/foundation_contract_gate.js` (strict enforcement)

## Enforced Invariants

1. Primitive count cap is enforced (`primitive_count_cap`).
2. Every adapter in `client/config/actuation_adapters.json` must have:
   - opcode mapping (`adapter_opcode_map`)
   - effect mapping (`adapter_effect_map`)
3. Every opcode used by runtime grammar must exist in migration contract `active_opcodes`.
4. Every opcode must carry self-description metadata (`opcode_metadata`) with:
   - invariants
   - cost class
   - safety class
5. Sub-executor abstraction debt must remain under baseline caps:
   - `max_active_sub_executors`
   - `max_total_sub_executor_candidates`
6. Foundation gate fails closed (`--strict=1`) if any invariant is violated.

## Why

This keeps execution primitive-first and blocks silent bespoke growth:

- new execution capability cannot ship without primitive mapping
- grammar evolution requires explicit migration contract updates
- runtime can introspect primitive safety/cost semantics via registry metadata
- temporary sub-executor specialization must distill or atrophy under debt caps
- phone-seed and cluster lanes stay on one opcode language
