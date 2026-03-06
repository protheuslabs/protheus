# Backlog Execution Path

Generated: 2026-03-06T17:52:53.553Z

## Summary

- Active rows: 102
- Queued rows: 86
- Blocked rows: 16
- Ordering strategy: impact-first with dependency-valid sequencing.

## Impact + Dependency Execution Order

| Rank | ID | Status | Priority | Open Dependencies | Title |
|---|---|---|---:|---|---|
| 1 | V6-F100-001 | queued | 38 |  | Reliability Certification Program (SLO/Error-Budget Gate) |
| 2 | V6-SEC-001 | in_progress | 37 | V6-F100-003 | Audited Release + SBOM Bundle (`v0.2.0`) |
| 3 | V6-PRIM-001 | in_progress | 35 | REQ-08-001 | Task Primitive Rust Completion |
| 4 | V6-PRIM-002 | in_progress | 35 | REQ-08-001 | Resource Primitive Rust Completion |
| 5 | V6-PRIM-003 | in_progress | 35 | REQ-08-001 | Isolation Primitive Rust Completion |
| 6 | V6-PRIM-006 | in_progress | 35 | REQ-08-001 | Observability Primitive Rust Completion |
| 7 | V6-F100-002 | queued | 33 | V6-F100-001 | SDLC Change-Control Plane (RFC/ADR/Risk Class) |
| 8 | V6-F100-003 | queued | 33 | V6-F100-002 | Secure Supply-Chain Provenance v2 (SBOM + Signed Artifacts) |
| 9 | V6-SEC-008 | in_progress | 32 |  | Continuous Fuzzing + Chaos Suite |
| 10 | V6-PRIM-009 | in_progress | 27 | REQ-08-005 | Primitive Migration Residual Audit |
| 11 | V6-SEC-004 | queued | 27 | V6-SEC-001 | Independent Security Audit Publication |
| 12 | V6-PRIM-008 | in_progress | 26 | REQ-08-002, REQ-08-004 | Primitive TS Wrapper Contract Enforcement |
| 13 | V6-F100-007 | queued | 25 | V6-F100-002 | API/CLI Contract Lifecycle (Versioning + Deprecation) |
| 14 | V6-SEC-005 | queued | 25 | V6-SEC-004 | Formal Verification Expansion (Constitution + Receipts + Conduit) |
| 15 | V6-F100-009 | queued | 23 | V6-F100-001 | Golden-Path Onboarding + Developer Portal |
| 16 | V6-ADAPT-001 | queued | 22 |  | Interaction-triggered real-time adaptation loop |
| 17 | V6-ADAPT-002 | queued | 22 |  | On-device low-power adaptation runtime profile |
| 18 | V6-ADAPT-003 | queued | 22 |  | Persistent adaptation continuity contract (“never forgets”) |
| 19 | V6-ADAPT-004 | queued | 22 |  | Covenant/drift fail-closed adaptation gates |
| 20 | V6-ADAPT-005 | queued | 22 |  | Persona/shadow review bridge for high-impact adaptation |
| 21 | V6-ADAPT-006 | queued | 22 |  | Apple-silicon adaptation profile + portable fallback |
| 22 | V6-BROWSER-001 | queued | 22 |  | Native browser daemon binary path |
| 23 | V6-BROWSER-002 | queued | 22 |  | Direct CDP native control primitives |
| 24 | V6-BROWSER-003 | queued | 22 |  | Encrypted profile/session persistence for browser native mode |
| 25 | V6-BROWSER-004 | queued | 22 |  | AI snapshot refs + annotation lane |
| 26 | V6-BROWSER-005 | queued | 22 |  | Native browser policy gates and CLI integration |
| 27 | V6-BROWSER-006 | queued | 22 |  | Zero-config browser daemon bootstrap lane |
| 28 | V6-BROWSER-007 | queued | 22 |  | Token-efficient text snapshot + diff endpoint lane |
| 29 | V6-BROWSER-008 | queued | 22 |  | Multi-instance orchestration + real-time dashboard lane |
| 30 | V6-BROWSER-009 | queued | 22 |  | Stealth + headed handoff control lane |
| 31 | V6-BROWSER-010 | queued | 22 |  | Blob-backed encrypted session continuity lane |
| 32 | V6-BROWSER-011 | queued | 22 |  | Multi-browser fallback profile lane |
| 33 | V6-BROWSER-012 | queued | 22 |  | Shadow/persona browser governance + drift breaker lane |
| 34 | V6-BROWSER-013 | queued | 22 |  | Browser API conformance harness lane |
| 35 | V6-BROWSER-014 | queued | 22 |  | Snapshot/diff token-efficiency SLO gate lane |
| 36 | V6-BROWSER-015 | queued | 22 |  | Zero-config startup + footprint verification lane |
| 37 | V6-BROWSER-016 | queued | 22 |  | Cross-language HTTP integration contract lane |
| 38 | V6-BROWSER-017 | queued | 22 |  | Comparative browser benchmark publication lane |
| 39 | V6-COMP-001 | queued | 22 |  | Competitive benchmark matrix with reproducible receipts |
| 40 | V6-COMP-002 | queued | 22 |  | `protheus migrate --from openfang` importer lane |
| 41 | V6-COMP-003 | queued | 22 |  | Evidence-first audit dashboard drilldown |
| 42 | V6-EDGE-004 | queued | 22 |  | Edge lifecycle validation + substrate-swap proof |
| 43 | V6-F100-004 | queued | 22 | V6-F100-002, V6-F100-003 | Compliance Evidence Automation (SOC2/ISO Audit Bundle) |
| 44 | V6-F100-005 | queued | 22 | V6-F100-001, V6-F100-003 | 1M-User Performance Certification Harness |
| 45 | V6-F100-006 | queued | 22 | V6-F100-003, V6-F100-005 | Multi-Tenant Isolation + Data Governance Contract |
| 46 | V6-F100-035 | queued | 22 |  | SPDX header sweep across source tree |
| 47 | V6-F100-036 | queued | 22 |  | Root experimental folder rationalization |
| 48 | V6-F100-041 | queued | 22 |  | Identity federation adapters (SSO/OAuth2/SCIM) for enterprise control plane |
| 49 | V6-F100-042 | queued | 22 |  | Audit-log export adapters for SIEM pipelines (Splunk/ELK/Datadog) |
| 50 | V6-FLUX-001 | queued | 22 |  | Flux conformance matrix and traceability lane |
| 51 | V6-FLUX-002 | queued | 22 |  | Ontological integrity operation gate lane |
| 52 | V6-FLUX-003 | queued | 22 |  | Coherence preference runtime verifier lane |
| 53 | V6-FLUX-004 | queued | 22 |  | Structural fluidity stress harness lane |
| 54 | V6-FLUX-005 | queued | 22 |  | Substrate probe evidence lane |
| 55 | V6-FLUX-006 | queued | 22 |  | Flux readiness operator status lane |
| 56 | V6-PAY-001 | queued | 22 |  | HTTP 402 challenge middleware for stateless payment gating |
| 57 | V6-PAY-002 | queued | 22 |  | XMR402 proof verification path |
| 58 | V6-PAY-003 | queued | 22 |  | Replay and double-spend mitigation guardrails |
| 59 | V6-PAY-004 | queued | 22 |  | Governed autonomous payment initiation for shadows |
| 60 | V6-PAY-005 | queued | 22 |  | RPC/config/subaddress integration contract |
| 61 | V6-PAY-006 | queued | 22 |  | Wallet deep-link + operator payment UX lane |
| 62 | V6-SBOX-002 | queued | 22 |  | Dynamic scoped sub-agent spawning |
| 63 | V6-SBOX-003 | queued | 22 |  | Persistent sandbox state bridge |
| 64 | V6-SBOX-004 | queued | 22 |  | On-demand skill/tool loader for sandbox workloads |
| 65 | V6-SBOX-005 | queued | 22 |  | Context compression controls for long-running sandbox tasks |
| 66 | V6-SHADOW-001 | queued | 22 |  | Structured shadow conclave runtime lane |
| 67 | V6-SHADOW-002 | queued | 22 |  | Asynchronous conclave workspace lane |
| 68 | V6-SHADOW-003 | queued | 22 |  | Eyes signal classifier and routing map lane |
| 69 | V6-SHADOW-004 | queued | 22 |  | Shadow dispatch/notification reliability lane |
| 70 | V6-SHADOW-005 | queued | 22 |  | Autonomous shadow proposal bridge lane |
| 71 | V6-SHADOW-006 | queued | 22 |  | Runtime health-gated routing/conclave lane |
| 72 | V6-SWARM-001 | queued | 22 |  | Swarm router primitive crate |
| 73 | V6-SWARM-002 | queued | 22 |  | Auto-ID + in-flight lifecycle tracker |
| 74 | V6-SWARM-003 | queued | 22 |  | Self-healing reroute policy for failed tasks |
| 75 | V6-SWARM-004 | queued | 22 |  | Queue-pressure auto-scaling planner |
| 76 | V6-SWARM-005 | queued | 22 |  | File-backed queue contract + priority ordering |
| 77 | V6-SWARM-006 | queued | 22 |  | Swarm observability and self-upgrade protocol |
| 78 | V6-TOOLS-001 | queued | 22 |  | Dynamic tool-context management plane |
| 79 | V6-TOOLS-003 | queued | 22 |  | Low-power messaging notification lane |
| 80 | V6-TOOLS-004 | queued | 22 |  | Shadow/persona bridge for tools and notifications |
| 81 | V6-F100-010 | queued | 21 | V6-F100-009 | Enterprise Architecture Narrative + Evidence Pack |
| 82 | V6-SEC-007 | queued | 21 | V6-SEC-001 | Public Dogfooding Program |
| 83 | V6-F100-008 | queued | 20 | V6-F100-001, V6-F100-002 | On-Call + Incident Command Maturity Pack |
| 84 | V6-F100-011 | queued | 16 | V6-F100-009, V6-F100-010 | Operator Surface Consistency Program (UX/Tone/State Model) |
| 85 | V6-SEC-009 | queued | 14 | V6-SEC-001, V6-SEC-004 | Government / High-Assurance Readiness Profile |
| 86 | V6-F100-012 | queued | 5 | V6-F100-001, V6-F100-002, V6-F100-004, V6-F100-005, V6-F100-009, V6-F100-010, V6-F100-011 | Executive Engineering Readiness Scorecard (Path to 90) |

## Deferred / Blocked

| ID | Class | Status | Block Reason |
|---|---|---|---|
| V6-COMP-005 | backlog | blocked | Blocked status in SRS |
| V6-EDGE-005 | backlog | blocked | Blocked status in SRS |
| V6-F100-022 | backlog | blocked | Blocked status in SRS |
| V6-F100-023 | backlog | blocked | Blocked status in SRS |
| V6-F100-024 | backlog | blocked | Blocked status in SRS |
| V6-F100-025 | backlog | blocked | Blocked status in SRS |
| V6-F100-034 | backlog | blocked | Blocked status in SRS |
| V6-F100-043 | backlog | blocked | Blocked status in SRS |
| V6-F100-044 | backlog | blocked | Blocked status in SRS |
| V6-F100-045 | backlog | blocked | Blocked status in SRS |
| V6-FLUX-007 | backlog | blocked | Blocked status in SRS |
| V6-GAP-006 | backlog | blocked | Open dependencies: V6-F100-034, V6-SEC-001 |
| V6-PAY-007 | backlog | blocked | Blocked status in SRS |
| V6-RUST50-CONF-004 | primitive-upgrade | blocked | Blocked status in SRS |
| V6-SBOX-006 | backlog | blocked | Blocked status in SRS |
| V6-TOOLS-005 | backlog | blocked | Blocked status in SRS |

