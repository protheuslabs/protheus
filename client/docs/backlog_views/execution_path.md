# Backlog Execution Path

Generated: 2026-03-08T16:55:18.673Z

## Summary

- Queued rows: 50
- Lane run commands discovered: 342
- Lane coverage (queued rows with lane): 0%
- Runnable now (lane + deps closed): 0
- Runnable but blocked by deps: 0
- Ready but no lane implementation: 46
- Blocked + no lane implementation: 4

## Recommended Next Actions

- Execute 0 runnable rows with existing lane commands first (lane:<id>:run + corresponding test:lane:<id>).
- For 46 dependency-ready rows without lanes, add runtime lane + test artifacts before marking done.
- Prioritize blocker dependencies (V6-SEC-001:3, V6-SEC-004:2) to unlock blocked rows fastest.

## Runnable Now

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|

## Ready But Missing Lane Implementation

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V6-ADAPT-CORE-001 | V6 | backlog | no |  | Port adaptation primitives to core and demote client runtime |
| V6-BROWSER-001 | V6 | backlog | no |  | Native browser daemon binary path |
| V6-BROWSER-002 | V6 | backlog | no |  | Direct CDP native control primitives |
| V6-BROWSER-003 | V6 | backlog | no |  | Encrypted profile/session persistence for browser native mode |
| V6-BROWSER-004 | V6 | backlog | no |  | AI snapshot refs + annotation lane |
| V6-BROWSER-005 | V6 | backlog | no |  | Native browser policy gates and CLI integration |
| V6-BROWSER-006 | V6 | backlog | no |  | Zero-config browser daemon bootstrap lane |
| V6-BROWSER-008 | V6 | backlog | no |  | Multi-instance orchestration + real-time dashboard lane |
| V6-BROWSER-009 | V6 | backlog | no |  | Stealth + headed handoff control lane |
| V6-BROWSER-010 | V6 | backlog | no |  | Blob-backed encrypted session continuity lane |
| V6-BROWSER-011 | V6 | backlog | no |  | Multi-browser fallback profile lane |
| V6-BROWSER-012 | V6 | backlog | no |  | Shadow/persona browser governance + drift breaker lane |
| V6-BROWSER-013 | V6 | backlog | no |  | Browser API conformance harness lane |
| V6-BROWSER-014 | V6 | backlog | no |  | Snapshot/diff token-efficiency SLO gate lane |
| V6-BROWSER-015 | V6 | backlog | no |  | Zero-config startup + footprint verification lane |
| V6-BROWSER-016 | V6 | backlog | no |  | Cross-language HTTP integration contract lane |
| V6-BROWSER-017 | V6 | backlog | no |  | Comparative browser benchmark publication lane |
| V6-COMP-001 | V6 | backlog | no |  | Competitive benchmark matrix with reproducible receipts |
| V6-COMP-002 | V6 | backlog | no |  | `protheus migrate --from openfang` importer lane |
| V6-COMP-003 | V6 | backlog | no |  | Evidence-first audit dashboard drilldown |
| V6-FLUX-001 | V6 | backlog | no |  | Flux conformance matrix and traceability lane |
| V6-FLUX-002 | V6 | backlog | no |  | Ontological integrity operation gate lane |
| V6-FLUX-003 | V6 | backlog | no |  | Coherence preference runtime verifier lane |
| V6-FLUX-004 | V6 | backlog | no |  | Structural fluidity stress harness lane |
| V6-FLUX-005 | V6 | backlog | no |  | Substrate probe evidence lane |
| V6-FLUX-006 | V6 | backlog | no |  | Flux readiness operator status lane |
| V6-PAY-001 | V6 | backlog | no |  | HTTP 402 challenge middleware for stateless payment gating |
| V6-PAY-002 | V6 | backlog | no |  | XMR402 proof verification path |
| V6-PAY-003 | V6 | backlog | no |  | Replay and double-spend mitigation guardrails |
| V6-PAY-004 | V6 | backlog | no |  | Governed autonomous payment initiation for shadows |
| V6-PAY-005 | V6 | backlog | no |  | RPC/client/config/subaddress integration contract |
| V6-PAY-006 | V6 | backlog | no |  | Wallet deep-link + operator payment UX lane |
| V6-SBOX-002 | V6 | backlog | no |  | Dynamic scoped sub-agent spawning |
| V6-SBOX-003 | V6 | backlog | no |  | Persistent sandbox state bridge |
| V6-SBOX-004 | V6 | backlog | no |  | On-demand skill/tool loader for sandbox workloads |
| V6-SBOX-005 | V6 | backlog | no |  | Context compression controls for long-running sandbox tasks |
| V6-SHADOW-001 | V6 | backlog | no |  | Structured shadow conclave runtime lane |
| V6-SHADOW-002 | V6 | backlog | no |  | Asynchronous conclave workspace lane |
| V6-SHADOW-005 | V6 | backlog | no |  | Autonomous shadow proposal bridge lane |
| V6-SHADOW-006 | V6 | backlog | no |  | Runtime health-gated routing/conclave lane |

## Top Dependency Blockers

| Dependency | Blocked Rows |
|---|---|
| V6-SEC-001 | 3 |
| V6-SEC-004 | 2 |

