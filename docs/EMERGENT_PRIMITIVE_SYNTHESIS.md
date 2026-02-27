# Emergent Primitive Synthesis Engine

`systems/primitives/emergent_primitive_synthesis.ts` provides a hard-gated lane for proposing new primitives without bypassing governance.

## Guarantees

- Primitive candidates are `nursery_only` by default
- Evaluation requires invariant checks + nursery + adversarial pass signals
- Explicit human approval gate required before promotion
- Rejected candidates auto-archive with lessons to avoid repeat unsafe synthesis
- Promotion writes auditable proposals/receipts (no implicit live mutation)

## Policy

Policy file: `config/emergent_primitive_synthesis_policy.json`

State/receipts:

- `state/primitives/synthesis/candidates.json`
- `state/primitives/synthesis/archive.jsonl`
- `state/primitives/synthesis/promotions.jsonl`
- `state/primitives/synthesis/receipts.jsonl`

## Commands

```bash
# Propose primitive candidate (forge/inversion/research source)
node systems/primitives/emergent_primitive_synthesis.js propose --name=adaptive_reduce --intent="bounded reduction primitive" --source=forge

# Evaluate candidate with required safety proofs
node systems/primitives/emergent_primitive_synthesis.js evaluate --candidate-id=<id> --nursery-pass=1 --adversarial-pass=1

# Human gate
node systems/primitives/emergent_primitive_synthesis.js approve --candidate-id=<id> --approved-by=operator --approval-note="reviewed"

# Promotion proposal (auto-promotion remains policy-gated)
node systems/primitives/emergent_primitive_synthesis.js promote --candidate-id=<id> --apply=0

# Manual rejection with lesson capture
node systems/primitives/emergent_primitive_synthesis.js reject --candidate-id=<id> --lesson="unsafe side effect under adversarial lane"
```
