# REQ-37 - V12 Hybrid Runtime Seal-Off

Date: 2026-03-09
Owner: Runtime Architecture
Status: Draft

## Goal

Close the final runtime gap between "hybrid works" and "hybrid feels native" by removing remaining polling/file-bound behavior in cockpit hot paths while preserving conduit authority and fail-closed safety.

## Scope

- Runtime transport and subscription path
- Runtime authority split (Rust vs Node)
- Identity hydration behavior
- Integrity reseal runtime behavior
- Ambient memory hot-path access

## Requirements

### REQ-37-001 WebSocket-Native Push Transport

`protheusd subscribe` MUST support a WebSocket-native stream transport with typed lifecycle events (`open`, `message`, `ack`, `reconnect`, `close`) and deterministic cursor-resume semantics.

Backlog mapping: `V6-COCKPIT-007`

### REQ-37-002 Rust/Node Runtime Unification

Runtime command authority MUST be Rust-first with Node wrappers restricted to conduit pass-through behavior (no policy authority). CLI and daemon surfaces MUST emit parity-consistent receipts.

Backlog mapping: `V6-COCKPIT-008`

### REQ-37-003 Fully Deferred Identity Hydration

Startup MUST use minimal identity boot context and defer `SOUL` and memory protocol page-in until query intent requires them. Hydration receipts MUST report deferred files and token budget compliance.

Backlog mapping: `V6-COCKPIT-009`

### REQ-37-004 Trusted Reseal Auto-Clear

Integrity reseal MUST auto-clear for explicitly trusted update classes under policy, with signed receipts. Non-trusted classes MUST remain fail-closed and emit clear remediation guidance.

Backlog mapping: `V6-COCKPIT-010`

### REQ-37-005 Shared-Pointer Ambient Memory Hotset

Ambient memory hot paths MUST support shared-pointer access (mmap/zero-copy) for resident queries and deterministically fall back to index-first node retrieval when unavailable.

Backlog mapping: `V6-MEMORY-020`

## Constraints

- No direct client-to-core bypass; conduit remains the only boundary.
- Degraded fallback must never widen privilege.
- Memory hot-path upgrades must preserve low-burn query contracts.
