# REQ-27: Global Importance and Priority Kernel

Status: in_progress  
Owner: Runtime Foundation  
Updated: 2026-03-07

## Objective

Establish one core-authoritative priority system that scores importance across all ambient/runtime events, orders work deterministically during collisions, and steers cockpit context toward the highest-impact signals first.

## Scope

- Rust core importance engine for normalized scoring (`0.0..1.0`) and priority banding (`P0..P4`).
- Priority-aware attention queue ordering used by all ambient producers.
- Initiative thresholds derived from importance score (silent -> persistent).
- Cockpit context inherits queue ordering and importance metadata without creating a second policy path.

## Non-Goals

- No LLM-driven scoring inside the core priority path.
- No TS/client authority for subconscious scoring or queue ordering.
- No direct auto-recall-to-initiative coupling as a policy authority.

## Functional Requirements

1. `REQ-27-001` Core authoritative importance scoring
- Every queued event must have a deterministic score and band.
- Scoring must run in Rust/core and remain non-probabilistic.

2. `REQ-27-002` Score model and override contract
- Score must support inherited hints (explicit `priority` / `importance.score`) and deterministic fallback scoring.
- Core/system health signals must enforce floor behavior so infra/security outrank higher-layer cognition when required.

3. `REQ-27-003` Priority queue ordering
- Attention queue must order events by:
  - band descending (`P0` highest)
  - priority descending
  - score descending
  - deadline ascending (if present)
  - age ascending
- Ordering must be deterministic and replay-safe.

4. `REQ-27-004` Initiative threshold contract
- Score thresholds must map to outreach behavior:
  - `<0.40`: silent/internal only
  - `0.40..0.70`: single proactive message
  - `0.70..0.85`: double follow-up
  - `0.85..0.95`: triple escalation
  - `>=0.95`: persistent until acknowledged
- Initiative metadata must be attached to queue events for downstream consumers.

5. `REQ-27-005` Collision handling primitive
- Queue ordering must be reusable as the default collision resolver for concurrent ambient tasks.
- High-importance events must be processed before low-importance events regardless of ingestion order.

6. `REQ-27-006` Cockpit steering data
- Cockpit ingestion must receive ordered attention events and importance metadata so the LLM sees highest-priority items first.
- This remains data-plane only; authority stays in core.

7. `REQ-27-007` Receipts and auditability
- Enqueue/status/consume receipts must include importance fields (`score`, `band`, `priority`, `initiative_action`) and deterministic `receipt_hash`.

## Safety Requirements

1. Fail closed on malformed importance hints (ignore hint, compute deterministic fallback).
2. Never allow client-surface code to become a second authority for scoring/ordering.
3. Preserve existing conduit-only boundary between client and core.
4. Enforce a regression guard that fails CI if REQ-27 subconscious authority tokens appear in `client/systems` or `client/lib`.

## Acceptance Criteria

1. `attention-queue enqueue` persists events with `importance` metadata and initiative action.
2. Queue processing order is priority-first (not FIFO when priorities differ).
3. Existing ambient producers (`spine`, `memory-ambient`, `persona-ambient`, `dopamine-ambient`) inherit the new scoring path without interface breakage.
4. Cockpit harness consumes events in priority order via existing queue APIs.
5. `cargo test -p protheus-ops-core attention_queue` and `cargo test -p protheus-ops-core importance` pass.
6. `npm run -s ops:subconscious-boundary:check` passes and fails closed on violations.
