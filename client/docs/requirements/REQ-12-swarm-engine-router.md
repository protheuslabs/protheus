# REQ-12: Swarm Engine Router and Autonomy Uplift

Version: 1.0  
Date: 2026-03-06

## Objective

Upgrade the coordinator/worker orchestration into a deterministic swarm engine with router semantics, queue-based handoff, self-healing execution, and observability receipts.

## Scope

In scope:
- Rust router primitive crate for message routing metadata and queue/state primitives.
- Automatic IDs, in-flight tracking, failure recovery routing, and task prioritization.
- File-backed queue contract for low-friction worker handoff.
- Swarm observability receipts and router upgrade/rollback protocol.

Out of scope:
- Replacing claim-evidence policy gates.
- Bypassing existing executor/worker governance constraints.
- Introducing non-deterministic orchestration behavior.

## Requirements

1. `REQ-12-001` Router primitive crate
- Acceptance:
  - Add a dedicated `swarm_router` crate.
  - Provide typed message envelope (`id`, `reply_to`, `route`, `payload`, `priority`, `status`).
  - Include baseline unit tests for route serialization/validation.

2. `REQ-12-002` Auto-ID generation
- Acceptance:
  - Coordinator/worker message envelopes support deterministic auto-ID generation by role prefix.
  - ID format is parseable and collision-safe for in-process usage.

3. `REQ-12-003` In-flight tracker
- Acceptance:
  - Router tracks task lifecycle (`pending`, `in_progress`, `complete`, `failed`) keyed by message ID.
  - New task dispatch checks for conflicting in-flight ownership.

4. `REQ-12-004` Self-healing failure route
- Acceptance:
  - Failed tasks can be deterministically requeued or rerouted to a designated fixer lane.
  - Recovery decision + outcome is emitted as receipt evidence.

5. `REQ-12-005` Auto-scaling worker planner
- Acceptance:
  - Queue pressure policy can recommend additional worker capacity.
  - Scaling decisions are policy-backed and reversible with receipts.

6. `REQ-12-006` File-backed queue contract
- Acceptance:
  - Introduce a canonical queue artifact contract (`queue.json` or equivalent typed format).
  - Worker handoff supports read/write with schema versioning and deterministic validation.

7. `REQ-12-007` Priority queue ordering
- Acceptance:
  - Task priority classes are enforced in scheduler ordering.
  - Equal-priority ordering remains deterministic.

8. `REQ-12-008` Swarm observability receipts
- Acceptance:
  - Every routing/handoff/recovery action produces auditable receipt records.
  - Swarm metrics can report queue depth, fail rate, retry count, and completion rate.

9. `REQ-12-009` Router self-upgrade protocol
- Acceptance:
  - Router update path supports atomic swap with rollback guard.
  - Upgrade and rollback events are receipt-backed and policy-gated.

## Verification Requirements

- Unit tests for ID generation, route validation, priority ordering, and queue serialization.
- Integration tests for failure recovery routing and in-flight conflict detection.
- Invariants and governance gates remain green after router integration.

## Execution Notes

- Start with minimal router contract and in-flight tracking, then layer recovery and scaling.
- Keep orchestration deterministic and auditable over convenience shortcuts.
