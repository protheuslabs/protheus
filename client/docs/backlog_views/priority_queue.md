# Backlog Priority Queue

Generated: 2026-03-06T19:03:30.022Z

Scoring model: impact + risk + dependency pressure (unblocks and unresolved deps), with status weighting.

## Summary

- Total rows: 1364
- Active rows: 86
- Completed rows: 1278

## Active Execution Order

| Rank | ID | Status | Priority | Impact | Risk | Unresolved Deps | Unlock Count | Title |
|---|---|---|---:|---:|---:|---:|---:|---|
| 1 | V6-SEC-001 | in_progress | 40 | 12 | 10 | 0 | 4 | Audited Release + SBOM Bundle (`v0.2.0`) |
| 2 | V6-RUST50-CONF-004 | blocked | 38 | 18 | 16 | 0 | 0 | Mega Sprint 1 Public 50 Percent Rust Migration (8 Crates + Blobized Core Paths) |
| 3 | V6-PRIM-001 | in_progress | 35 | 18 | 10 | 1 | 0 | Task Primitive Rust Completion |
| 4 | V6-PRIM-002 | in_progress | 35 | 18 | 10 | 1 | 0 | Resource Primitive Rust Completion |
| 5 | V6-PRIM-003 | in_progress | 35 | 18 | 10 | 1 | 0 | Isolation Primitive Rust Completion |
| 6 | V6-PRIM-006 | in_progress | 35 | 18 | 10 | 1 | 0 | Observability Primitive Rust Completion |
| 7 | V6-SEC-008 | in_progress | 32 | 12 | 10 | 0 | 0 | Continuous Fuzzing + Chaos Suite |
| 8 | V6-F100-034 | blocked | 28 | 6 | 16 | 0 | 1 | First public semantic release + npm publish |
| 9 | V6-PRIM-009 | in_progress | 27 | 10 | 10 | 1 | 0 | Primitive Migration Residual Audit |
| 10 | V6-SEC-004 | queued | 27 | 10 | 8 | 1 | 2 | Independent Security Audit Publication |
| 11 | V6-COMP-005 | blocked | 26 | 6 | 16 | 0 | 0 | Public multi-release cadence target (9+ tags) |
| 12 | V6-EDGE-005 | blocked | 26 | 6 | 16 | 0 | 0 | Third-party license and source-ingest decision for edge backend |
| 13 | V6-F100-022 | blocked | 26 | 6 | 16 | 0 | 0 | Live trading proof gate (30-day promotion evidence) |
| 14 | V6-F100-023 | blocked | 26 | 6 | 16 | 0 | 0 | Third-party security audit publication |
| 15 | V6-F100-024 | blocked | 26 | 6 | 16 | 0 | 0 | Horizontal scaling proof in production profile |
| 16 | V6-F100-025 | blocked | 26 | 6 | 16 | 0 | 0 | Continuous chaos weekly evidence contract |
| 17 | V6-F100-043 | blocked | 26 | 6 | 16 | 0 | 0 | External certification and attestation program (SOC2/ISO/FedRAMP/GDPR) |
| 18 | V6-F100-044 | blocked | 26 | 6 | 16 | 0 | 0 | Commercial support/SLA contract lane (enterprise readiness) |
| 19 | V6-F100-045 | blocked | 26 | 6 | 16 | 0 | 0 | Public compliance report publication lane |
| 20 | V6-FLUX-007 | blocked | 26 | 6 | 16 | 0 | 0 | Advanced substrate live validation lane |
| 21 | V6-PAY-007 | blocked | 26 | 6 | 16 | 0 | 0 | Monero network/compliance profile decision for production rollout |
| 22 | V6-PRIM-008 | in_progress | 26 | 12 | 10 | 2 | 0 | Primitive TS Wrapper Contract Enforcement |
| 23 | V6-SBOX-006 | blocked | 26 | 6 | 16 | 0 | 0 | Sandbox runtime substrate decision (container vs lightweight jail) |
| 24 | V6-TOOLS-005 | blocked | 26 | 6 | 16 | 0 | 0 | Optional reactions/worktree event automation track |
| 25 | V6-SEC-005 | queued | 25 | 12 | 8 | 1 | 0 | Formal Verification Expansion (Constitution + Receipts + Conduit) |
| 26 | V6-ADAPT-001 | queued | 22 | 6 | 8 | 0 | 0 | Interaction-triggered real-time adaptation loop |
| 27 | V6-ADAPT-002 | queued | 22 | 6 | 8 | 0 | 0 | On-device low-power adaptation runtime profile |
| 28 | V6-ADAPT-003 | queued | 22 | 6 | 8 | 0 | 0 | Persistent adaptation continuity contract (“never forgets”) |
| 29 | V6-ADAPT-004 | queued | 22 | 6 | 8 | 0 | 0 | Covenant/drift fail-closed adaptation gates |
| 30 | V6-ADAPT-005 | queued | 22 | 6 | 8 | 0 | 0 | Persona/shadow review bridge for high-impact adaptation |
| 31 | V6-ADAPT-006 | queued | 22 | 6 | 8 | 0 | 0 | Apple-silicon adaptation profile + portable fallback |
| 32 | V6-BROWSER-001 | queued | 22 | 6 | 8 | 0 | 0 | Native browser daemon binary path |
| 33 | V6-BROWSER-002 | queued | 22 | 6 | 8 | 0 | 0 | Direct CDP native control primitives |
| 34 | V6-BROWSER-003 | queued | 22 | 6 | 8 | 0 | 0 | Encrypted profile/session persistence for browser native mode |
| 35 | V6-BROWSER-004 | queued | 22 | 6 | 8 | 0 | 0 | AI snapshot refs + annotation lane |
| 36 | V6-BROWSER-005 | queued | 22 | 6 | 8 | 0 | 0 | Native browser policy gates and CLI integration |
| 37 | V6-BROWSER-006 | queued | 22 | 6 | 8 | 0 | 0 | Zero-config browser daemon bootstrap lane |
| 38 | V6-BROWSER-007 | queued | 22 | 6 | 8 | 0 | 0 | Token-efficient text snapshot + diff endpoint lane |
| 39 | V6-BROWSER-008 | queued | 22 | 6 | 8 | 0 | 0 | Multi-instance orchestration + real-time dashboard lane |
| 40 | V6-BROWSER-009 | queued | 22 | 6 | 8 | 0 | 0 | Stealth + headed handoff control lane |
| 41 | V6-BROWSER-010 | queued | 22 | 6 | 8 | 0 | 0 | Blob-backed encrypted session continuity lane |
| 42 | V6-BROWSER-011 | queued | 22 | 6 | 8 | 0 | 0 | Multi-browser fallback profile lane |
| 43 | V6-BROWSER-012 | queued | 22 | 6 | 8 | 0 | 0 | Shadow/persona browser governance + drift breaker lane |
| 44 | V6-BROWSER-013 | queued | 22 | 6 | 8 | 0 | 0 | Browser API conformance harness lane |
| 45 | V6-BROWSER-014 | queued | 22 | 6 | 8 | 0 | 0 | Snapshot/diff token-efficiency SLO gate lane |
| 46 | V6-BROWSER-015 | queued | 22 | 6 | 8 | 0 | 0 | Zero-config startup + footprint verification lane |
| 47 | V6-BROWSER-016 | queued | 22 | 6 | 8 | 0 | 0 | Cross-language HTTP integration contract lane |
| 48 | V6-BROWSER-017 | queued | 22 | 6 | 8 | 0 | 0 | Comparative browser benchmark publication lane |
| 49 | V6-COMP-001 | queued | 22 | 6 | 8 | 0 | 0 | Competitive benchmark matrix with reproducible receipts |
| 50 | V6-COMP-002 | queued | 22 | 6 | 8 | 0 | 0 | `protheus migrate --from openfang` importer lane |
| 51 | V6-COMP-003 | queued | 22 | 6 | 8 | 0 | 0 | Evidence-first audit dashboard drilldown |
| 52 | V6-EDGE-004 | queued | 22 | 6 | 8 | 0 | 0 | Edge lifecycle validation + substrate-swap proof |
| 53 | V6-FLUX-001 | queued | 22 | 6 | 8 | 0 | 0 | Flux conformance matrix and traceability lane |
| 54 | V6-FLUX-002 | queued | 22 | 6 | 8 | 0 | 0 | Ontological integrity operation gate lane |
| 55 | V6-FLUX-003 | queued | 22 | 6 | 8 | 0 | 0 | Coherence preference runtime verifier lane |
| 56 | V6-FLUX-004 | queued | 22 | 6 | 8 | 0 | 0 | Structural fluidity stress harness lane |
| 57 | V6-FLUX-005 | queued | 22 | 6 | 8 | 0 | 0 | Substrate probe evidence lane |
| 58 | V6-FLUX-006 | queued | 22 | 6 | 8 | 0 | 0 | Flux readiness operator status lane |
| 59 | V6-PAY-001 | queued | 22 | 6 | 8 | 0 | 0 | HTTP 402 challenge middleware for stateless payment gating |
| 60 | V6-PAY-002 | queued | 22 | 6 | 8 | 0 | 0 | XMR402 proof verification path |
| 61 | V6-PAY-003 | queued | 22 | 6 | 8 | 0 | 0 | Replay and double-spend mitigation guardrails |
| 62 | V6-PAY-004 | queued | 22 | 6 | 8 | 0 | 0 | Governed autonomous payment initiation for shadows |
| 63 | V6-PAY-005 | queued | 22 | 6 | 8 | 0 | 0 | RPC/client/config/subaddress integration contract |
| 64 | V6-PAY-006 | queued | 22 | 6 | 8 | 0 | 0 | Wallet deep-link + operator payment UX lane |
| 65 | V6-SBOX-002 | queued | 22 | 6 | 8 | 0 | 0 | Dynamic scoped sub-agent spawning |
| 66 | V6-SBOX-003 | queued | 22 | 6 | 8 | 0 | 0 | Persistent sandbox state bridge |
| 67 | V6-SBOX-004 | queued | 22 | 6 | 8 | 0 | 0 | On-demand skill/tool loader for sandbox workloads |
| 68 | V6-SBOX-005 | queued | 22 | 6 | 8 | 0 | 0 | Context compression controls for long-running sandbox tasks |
| 69 | V6-SHADOW-001 | queued | 22 | 6 | 8 | 0 | 0 | Structured shadow conclave runtime lane |
| 70 | V6-SHADOW-002 | queued | 22 | 6 | 8 | 0 | 0 | Asynchronous conclave workspace lane |
| 71 | V6-SHADOW-003 | queued | 22 | 6 | 8 | 0 | 0 | Eyes signal classifier and routing map lane |
| 72 | V6-SHADOW-004 | queued | 22 | 6 | 8 | 0 | 0 | Shadow dispatch/notification reliability lane |
| 73 | V6-SHADOW-005 | queued | 22 | 6 | 8 | 0 | 0 | Autonomous shadow proposal bridge lane |
| 74 | V6-SHADOW-006 | queued | 22 | 6 | 8 | 0 | 0 | Runtime health-gated routing/conclave lane |
| 75 | V6-SWARM-001 | queued | 22 | 6 | 8 | 0 | 0 | Swarm router primitive crate |
| 76 | V6-SWARM-002 | queued | 22 | 6 | 8 | 0 | 0 | Auto-ID + in-flight lifecycle tracker |
| 77 | V6-SWARM-003 | queued | 22 | 6 | 8 | 0 | 0 | Self-healing reroute policy for failed tasks |
| 78 | V6-SWARM-004 | queued | 22 | 6 | 8 | 0 | 0 | Queue-pressure auto-scaling planner |
| 79 | V6-SWARM-005 | queued | 22 | 6 | 8 | 0 | 0 | File-backed queue contract + priority ordering |
| 80 | V6-SWARM-006 | queued | 22 | 6 | 8 | 0 | 0 | Swarm observability and self-upgrade protocol |
| 81 | V6-TOOLS-001 | queued | 22 | 6 | 8 | 0 | 0 | Dynamic tool-context management plane |
| 82 | V6-TOOLS-003 | queued | 22 | 6 | 8 | 0 | 0 | Low-power messaging notification lane |
| 83 | V6-TOOLS-004 | queued | 22 | 6 | 8 | 0 | 0 | Shadow/persona bridge for tools and notifications |
| 84 | V6-SEC-007 | queued | 21 | 8 | 8 | 1 | 0 | Public Dogfooding Program |
| 85 | V6-GAP-006 | blocked | 20 | 6 | 16 | 2 | 0 | Public Release + Announcement Publication Authority |
| 86 | V6-SEC-009 | queued | 14 | 4 | 8 | 2 | 0 | Government / High-Assurance Readiness Profile |

