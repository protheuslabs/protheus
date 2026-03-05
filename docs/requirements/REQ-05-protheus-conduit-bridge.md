# REQ-05 Protheus Conduit Bridge

Version: 1.0
Date: 2026-03-05

## Purpose

Define a narrow, typed, fail-closed bridge between Rust core (TCB) and TypeScript surfaces so UI/marketplace/extensions can stay flexible without compromising portability and sovereignty.

## Goals

- Preserve Rust-first invariants for constitution/policy/receipt enforcement.
- Keep TS optional and removable for kernel/bare-metal modes.
- Support low-latency hosted operation (`<5ms` round trip target).
- Ensure deterministic claim-evidence logging for every crossing.

## Scope

In scope:

- `crates/conduit` Rust crate
- `systems/conduit/conduit-client.ts` typed TS client
- Typed JSON schema for Unix socket + stdio
- Rust-side validation and policy gate enforcement
- Deterministic crossing receipts

Out of scope:

- Shared memory/direct function call bypass
- TS-owned persistent core state
- Complex RPC frameworks

## Protocol (10 core messages)

TS -> Rust commands:

1. `start_agent`
2. `stop_agent`
3. `query_receipt_chain`
4. `list_active_agents`
5. `get_system_status`
6. `apply_policy_update` (constitution-safe only)
7. `install_extension`

Rust -> TS events/responses:

8. `agent_started` / `agent_stopped`
9. `receipt_added`
10. `system_status` / `policy_violation`

## Validation Requirements

- Rust is source of truth for schema and policy checks.
- Invalid input or denied policy evaluates fail-closed.
- `apply_policy_update` requires `constitution_safe/*` patch IDs.
- `install_extension` requires valid sha256 + explicit capabilities.

## Transport Requirements

- Primary: Unix domain socket (hosted)
- Fallback: stdio (embedded/lightweight)

## Test Requirements

- Unit tests for schema, validation, and deterministic hashes.
- Stdio round-trip test.
- Invariant tests for fail-closed behavior.

## Initial Delivery (Phase 1)

Delivered in this increment:

- `crates/conduit` scaffold + typed schema
- deterministic receipt hashing
- Rust-side validation gate framework
- Unix socket + stdio transport handlers
- TS typed client scaffold
