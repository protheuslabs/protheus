# Explanation Primitive

`client/systems/primitives/explanation_primitive.ts` implements `V3-058`.

It creates canonical explanation artifacts for major decisions, policy denials, and self-modification events with both:

- human-readable narrative fields
- machine-verifiable proof links bound to canonical event-chain evidence

## Commands

- `node client/systems/primitives/explanation_primitive.js explain --event-id=<id|latest> --category=<major_decision|policy_denial|self_modification> --summary="..." [--narrative="..."] [--decision=<allow|deny|propose>] [--objective-id=<id>] [--apply=1|0]`
- `node client/systems/primitives/explanation_primitive.js verify --explanation-id=<id> [--strict=1|0]`
- `node client/systems/primitives/explanation_primitive.js status`

## Artifact Contract

Each artifact includes:

- `explanation_id`
- `event_ref` (event id/hash/seq/log path)
- `proof_links` (canonical event, chain verification, causal summary, external references)
- `summary` + `narrative`
- `machine_verification` and `artifact_hash`

Artifacts are written to `state/primitives/explanation_primitive/artifacts/*.json`.

## Replay + Proof Guarantees

- Canonical events are re-verified via `verifyCanonicalEvents(...)`.
- Policy can require replayability (`require_event_replayable=true`) and fail closed otherwise.
- Verification rechecks artifact hash and event linkage.

## Passport Export Lane

When `passport_export.enabled=true`, generated explanation artifacts are appended into the Agent Passport chain as `action_type=explanation_artifact` via `appendAction(...)`.

This keeps explanation receipts exportable through existing passport lanes (JSON/PDF).

## Policy

`client/config/explanation_primitive_policy.json` controls:

- required evidence gates
- allowed categories
- shadow mode
- state paths
- passport export behavior

