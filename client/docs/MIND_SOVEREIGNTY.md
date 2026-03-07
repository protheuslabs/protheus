# Mind Sovereignty

Mind sovereignty is the non-negotiable top rule for Protheus.

## Core Guarantees

- Identity boundaries (human, primary mind, guest mind, sub-agent mind) remain isolated by default.
- Soul-vector continuity remains tamper-evident and cannot be silently rewritten by mutation lanes.
- Merge interfaces require explicit consent ceremony, reversible rollback, and kill-switch availability.
- High-impact promotions fail closed when sovereignty proofs fail.
- Containment and lineage-ban controls override optimization and throughput incentives.

## Enforcement Surfaces

- `AGENT-CONSTITUTION.md` covenant preamble and runtime policy references.
- `V3-RACE-035` formal sovereignty verification lane.
- `V3-RACE-036` multi-mind isolation boundary plane.
- `V3-RACE-039` merge interface protection substrate.
- `V3-RACE-032` complexity warden sovereignty-priority pruning guard.

## Drift Policy

- Any governance drift that weakens these guarantees is a release-blocking defect.
- CI and backlog contract gates must fail on covenant divergence.

## Pinnacle Compatibility Clause (`V3-RACE-144`)

- Pinnacle integration lanes (`V3-RACE-137`..`143`) are compatible only when:
  - event publication + receipts remain mandatory,
  - risk-tier governance remains non-bypass,
  - user-private data boundaries remain intact (`client/memory/` + `client/adaptive/` only).
- Enforcement is machine-checked via:
  - `client/systems/ops/pinnacle_integration_contract_check.ts`
