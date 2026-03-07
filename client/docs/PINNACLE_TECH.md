# Pinnacle Tech Integration

`V3-RACE-137` through `V3-RACE-144` define the governed integration contract for:

- CRDT local-first state
- WASM component runtime
- Intent declaration + translation
- DID/VC identity binding
- Content-addressed archival
- ZK compliance proofs
- FHE encrypted compute pilot

## Cross-Lane Invariants

1. Risk-tier gating defaults to `<=2`; tier `3+` requires explicit approval.
2. Event publication and receipts are mandatory for every mutation path.
3. User-specific state stays in `client/memory/` + `client/adaptive/`.
4. Permanent runtime and policy logic stays in `client/systems/` + `client/config/` + `client/docs/`.

## Contract Check

Run:

```bash
node client/systems/ops/pinnacle_integration_contract_check.js check --strict=1
```

Artifacts:

- `state/ops/pinnacle_integration_contract_check/latest.json`
- `state/ops/pinnacle_integration_contract_check/receipts.jsonl`
