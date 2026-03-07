# Mech Suit Cockpit Harness Requirements

Date: 2026-03-06  
Owner: Runtime Foundation  
Status: Approved for implementation

## Objective

Attach ambient mech-suit outputs to cockpit-facing LLM runtime so the system can operate as background-first infrastructure instead of manual command orchestration.

## Scope

- Add Rust attention-queue consumer contract for deterministic event handoff.
- Add cockpit harness worker to ingest attention events through conduit.
- Enrich cockpit envelopes with ambient spine, persona, and dopamine status.
- Persist bounded cockpit inbox artifacts for deterministic replay.
- Expose cockpit context through control-plane status path.

## Non-Goals

- No second policy path outside Rust authority lanes.
- No removal of existing compatibility wrappers.
- No broad redesign of routing/provider gateway internals.

## Functional Requirements

1. `attention-queue` supports consumer flow:
- `next`: read without ack using consumer cursor.
- `ack`: advance cursor with deterministic token validation.
- `drain`: bounded read + ack in one command.

2. Commands emit deterministic JSON receipts with `receipt_hash`.

3. Cockpit harness supports:
- `once`: consume available queue events and emit one cockpit envelope.
- `watch`: react to queue file changes and ingest without polling loops.
- `status`: report latest envelope metadata and worker health.

4. Cockpit envelope includes:
- attention events ingested this cycle
- spine ambient status snapshot
- persona ambient stance snapshot
- dopamine ambient status snapshot
- envelope metadata (`ts`, `sequence`, `consumer_id`, `receipt_hash`)

5. Artifacts:
- `state/cockpit/inbox/latest.json`
- `state/cockpit/inbox/history.jsonl`
- `state/cockpit/inbox/state.json` (cursor/worker metadata)

6. Control-plane status path includes latest cockpit envelope summary when available.

## Safety Requirements

1. Fail closed on malformed cursor tokens, invalid args, or corrupted queue entries.
2. Do not mutate policy authority; only consume existing runtime-authoritative outputs.
3. Preserve existing mech-suit behavior and compatibility surfaces.

## Acceptance Criteria

1. `attention-queue next|ack|drain` works with deterministic cursor progression.
2. `cockpit_harness once` writes latest/history/state artifacts.
3. `cockpit_harness watch` responds to queue updates via file events.
4. Conduit `get_system_status` includes cockpit summary when inbox exists.
5. Existing mech-suit benchmark remains passing.
6. `formal:invariants:run` remains passing.

