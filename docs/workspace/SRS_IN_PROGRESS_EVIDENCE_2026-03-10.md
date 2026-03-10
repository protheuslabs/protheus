# In-Progress SRS Evidence Map (2026-03-10)

Purpose:
- Eliminate ambiguous `in_progress` status by linking each active ID to concrete implementation surfaces.
- Support deterministic regression checks that require non-backlog evidence.

## V6-INITIATIVE-013

- ID: `V6-INITIATIVE-013`
- Evidence surfaces:
  - `core/layer0/ops/src/importance.rs`
  - `core/layer0/ops/src/attention_queue.rs`
  - `core/layer0/ops/src/spine.rs`
  - `docs/client/requirements/REQ-27-global-importance-priority-kernel.md`

## V6-SWARM-001..006

- ID: `V6-SWARM-001`
- ID: `V6-SWARM-002`
- ID: `V6-SWARM-003`
- ID: `V6-SWARM-004`
- ID: `V6-SWARM-005`
- ID: `V6-SWARM-006`
- Evidence surfaces:
  - `core/layer0/swarm_router/src/lib.rs`
  - `core/layer0/swarm_router/src/main.rs`
  - `core/layer0/swarm_router/Cargo.toml`
  - `core/layer0/ops/src/spawn_broker.rs`
  - `docs/client/requirements/REQ-12-swarm-engine-router.md`

## V6-ARCH-ICEBERG-028

- ID: `V6-ARCH-ICEBERG-028`
- Evidence surfaces:
  - `core/layer0/ops/src/importance.rs`
  - `core/layer0/ops/src/attention_queue.rs`
  - `core/layer0/ops/src/protheus_control_plane.rs`
  - `docs/client/requirements/REQ-28-conscious-subconscious-iceberg-v1.md`
  - `docs/client/architecture/SYSTEM_MAP.md`

Notes:
- This document is evidence linking only; it does not claim completion of the listed IDs.
- Completion remains governed by acceptance criteria in `docs/workspace/SRS.md`.
