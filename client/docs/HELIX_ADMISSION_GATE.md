# Helix Admission Gate

`V3-032` adds strand-admission checks that sit between capability synthesis and live grafting.

## Commands

```bash
node client/systems/helix/helix_admission_gate.js candidate --source=assimilation --capability-id=cap_example
node client/systems/helix/helix_admission_gate.js admit --candidate-json="$CANDIDATE_JSON" --apply=1 --doctor-approved=1
node client/systems/helix/helix_admission_gate.js status
```

## Behavior

- Assimilation/Forge outputs include deterministic `strand_candidate` payloads.
- Doctor-facing graft/promotion lanes require valid strand hash + source/codex compliance.
- Approved apply paths atomically refresh `state/helix/manifest.json` and emit admission receipts.
