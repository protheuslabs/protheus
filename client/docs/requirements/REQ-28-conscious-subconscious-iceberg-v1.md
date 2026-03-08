# REQ-28: Conscious/Subconscious Iceberg Specification v1.0

Status: in_progress  
Owner: Architecture + Runtime Foundation  
Updated: 2026-03-07

Source contract: `docs/SYSTEM-ARCHITECTURE-SPECS.md`

## Objective

Make the iceberg architecture executable: strict ownership for `core/layer0..3`, upward-only flow, conduit-only client/core boundary, and deterministic Layer2 initiative/priority primitives.

## Functional Requirements

1. `REQ-28-001` Source-of-truth architecture contract
- Maintain the locked architecture spec in `docs/SYSTEM-ARCHITECTURE-SPECS.md`.
- `ARCHITECTURE.md` must reference this contract explicitly.

2. `REQ-28-002` Layered ownership guardrails
- Subconscious authority remains in `core/` only.
- Client code must not implement initiative, priority scoring internals, or queue-front authority.
- CI must fail closed when forbidden subconscious patterns appear under client surfaces.

3. `REQ-28-003` Layer2 initiative score primitive
- Provide deterministic non-LLM scoring primitive in Layer2 using:
  `0.35*criticality + 0.25*urgency + 0.20*impact + 0.15*user_relevance + 0.05*confidence` plus optional `core_floor`.
- Support inherited score hints with bounded deterministic adjustment.

4. `REQ-28-004` Layer2 initiative threshold primitive
- Provide deterministic threshold mapping:
  - `<0.40`: `silent`
  - `0.40..0.70`: `single_message`
  - `0.70..0.85`: `double_message`
  - `>0.85`: `triple_escalation`
  - `>0.95`: `persistent_until_ack`

5. `REQ-28-005` Layer2 attention priority primitive
- Provide queue-priority shaping primitive with front-jump behavior for score `>= 0.70`.
- Ordering must be deterministic and stable for ties.

## Safety Requirements

1. Deterministic fail-closed behavior on malformed JSON payloads.
2. No direct client authority for subconscious logic.
3. Preserve conduit-only client/core communication boundary.

## Acceptance Criteria

1. `docs/SYSTEM-ARCHITECTURE-SPECS.md` exists and is referenced by `ARCHITECTURE.md`.
2. `execution_core initiative-score` command returns deterministic score/priority/band/initiative metadata.
3. `execution_core initiative-action` command returns deterministic action mapping for a supplied score.
4. `execution_core attention-priority` command returns priority-ordered events with front-jump metadata.
5. `npm run -s ops:subconscious-boundary:check` remains pass/fail authoritative for client-side regressions.

## Implementation Notes

Current runtime still has authoritative priority paths in `core/layer0/ops/src/importance.rs` and `core/layer0/ops/src/attention_queue.rs`.
`REQ-28` introduces Layer2-compatible primitives without breaking live authority while migration proceeds.
