# Architecture Ownership

Purpose: define which layer owns which decisions, and which modules are allowed to mutate adaptive state.

## Ownership Matrix

| Layer/Path | Ownership | May Mutate | Mutation Channel |
|---|---|---|---|
| `systems/` | Control plane + safety infrastructure | No direct adaptive writes except controller stores | N/A |
| `adaptive/` | Runtime-adaptive policy/state data | Data only (no arbitrary writes) | `systems/adaptive/*/*_store.js` |
| `habits/` | Dynamic routine execution and generation | Habit runtime/state only | Habit scripts + adaptive habit store |
| `skills/` | Task-specific integrations | Skill-local files and allowed state receipts | Skill wrappers + guards |
| `config/` | Static policy/config contracts | Only approved governance flows | Guarded writes |
| `state/` | Runtime outputs and ledgers | Runtime emitters only | Append/log + bounded writers |

## Adaptive Store Controllers (Single Writer Channels)

Only these modules are canonical adaptive mutators:

- `systems/adaptive/core/layer_store.js`
- `systems/adaptive/sensory/eyes/catalog_store.js`
- `systems/adaptive/sensory/eyes/focus_trigger_store.js`
- `systems/adaptive/habits/habit_store.js`
- `systems/adaptive/reflex/reflex_store.js`
- `systems/adaptive/strategy/strategy_store.js`

Guard policy:

- `systems/sensory/adaptive_layer_guard.js`
- `config/adaptive_layer_guard_policy.json`

CI enforces this in strict mode.

## Schema Contracts (Single Source)

Versioned contracts live in:

- `config/contracts/autonomy_receipt.schema.json`
- `config/contracts/proposal_admission.schema.json`
- `config/contracts/adaptive_store.schema.json`

Validation entrypoint:

- `node systems/security/schema_contract_check.js run`

CI executes this check before general test execution.

## Design Rules

1. `systems/` should remain broadly reusable; no business specialization in system modules.
2. `adaptive/` is resettable; deleting adaptive data should return the system to a blank-slate learning posture.
3. All adaptive writes must go through store getters/setters/mutators.
4. Contract changes require a schema version bump and CI passing against updated contracts.
5. Runtime churn in `state/` should not be treated as source-of-truth for code review.

## Incident Boundaries

If behavior drifts:

1. Check `schema_contract_check` output.
2. Check adaptive guard strict output.
3. Check recent store mutation logs in `state/security/adaptive_mutations.jsonl`.
4. Roll back by commit boundary, not ad-hoc file edits.

