# Memory Ambient Contract Requirements

Date: 2026-03-06  
Owner: Runtime Foundation  
Status: Approved for implementation

## Objective

Bring memory operations into ambient mode with Rust-authoritative policy and conduit-routed TS surfaces so cockpit/runtime can consume memory without manual orchestration.

## Scope

- Add `memory-ambient` domain to Rust ops lane.
- Add conduit bridge support for memory ambient commands.
- Convert TS memory surface to conduit-first path with explicit compatibility mode.
- Route memory escalation events into the Rust attention queue.
- Persist deterministic memory ambient receipts and status updates.

## Non-Goals

- No removal of existing memory capabilities (`recall`, `ingest`, `compress`, `crdt`, embedded profiles, etc.).
- No second policy authority in TS wrappers.
- No redesign of memory core internals inside `core/layer0/memory`.

## Functional Requirements

1. `protheus-ops memory-ambient` supports:
- `run` for executing allowed memory core commands.
- `status` for cached ambient status without direct polling work.

2. `run` receipts include:
- ambient mode flags
- rust authority status
- underlying memory command result
- attention queue decision
- deterministic `receipt_hash`

3. Conduit bridge supports `memory_ambient_command` routing to Rust lane.

4. TS memory surface is conduit-first by default and compatibility-only when explicitly enabled.

5. Attention queue receives memory escalation events according to policy thresholds.

## Safety Requirements

1. Fail closed on malformed payloads, unsupported commands, or bridge errors.
2. Preserve security gate behavior for memory operations.
3. Keep compatibility mode explicit (dev/compat toggle), not implicit fallback authority.

## Acceptance Criteria

1. Memory ambient lane compiles and is reachable via conduit bridge.
2. Memory wrapper no longer directly owns policy authority.
3. `formal:invariants:run` remains passing.
4. Benchmark includes memory ambient case and reports memory token impact.
5. Status artifacts show memory component active under mech-suit ambient runtime.
