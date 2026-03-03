# Backlog Active View

Generated: 2026-03-03T03:15:13.205Z

| ID | Class | Wave | Status | Title | Dependencies |
|---|---|---|---|---|---|
| V5-HOLD-001 | hardening | V5 | queued | Unchanged-State Admission Gate | V4-SELF-001, V4-SCALE-003 |
| V5-HOLD-002 | hardening | V5 | queued | Confidence Routing Calibration + Canary Execute Band | V5-HOLD-001, V4-SCALE-007 |
| V5-HOLD-003 | scale-readiness | V5 | queued | Cap-Aware Deferred Queue Scheduler | V4-SCALE-003, V4-SCALE-007 |
| V5-HOLD-004 | hardening | V5 | queued | Routeability Preflight Lint (`not_executable` / `gate_manual`) | V5-HOLD-001, V4-SCALE-008 |
| V5-HOLD-005 | hardening | V5 | queued | Budget Burst Smoothing + Autopause Prevention | V5-HOLD-003, V4-SCALE-010 |
| V4-ETH-001 | primitive-upgrade | V4 | queued | Dynamic Blob Morphing | V4-SETTLE-006, V4-SETTLE-007, V4-SETTLE-010 |
| V4-ETH-002 | primitive-upgrade | V4 | queued | Flux-State Memory Substrate | V3-RACE-065, V4-SCI-008, V4-SELF-001 |
| V4-ETH-003 | extension | V4 | queued | Shadow Self + Instant Reconfiguration | V4-SETTLE-006, V4-SETTLE-008, V4-SETTLE-010 |
| V4-ETH-004 | extension | V4 | queued | Probabilistic Execution Weave | V4-ETH-002, V4-SCI-008, V4-SCALE-007 |
| V4-ETH-005 | launch-polish | V4 | queued | Idle Dissolution + On-Demand Coalescence | V4-ETH-001, V4-SETTLE-002, V4-SETTLE-008 |
| V4-SEC-014 | hardening | V4 | queued | Covenant Enforcement Across Flux/Morph/Shadow Operations | V4-ETH-001, V4-ETH-002, V4-ETH-003, V4-FORT-006 |
| V4-SEC-015 | hardening | V4 | queued | Tamper Self-Revocation + Vault Re-Coalesce | V4-ETH-001, V4-SETTLE-002, V4-SCALE-009 |
| V4-SEC-016 | launch-polish | V4 | queued | Live Security Mirror Panel in `protheus-top` | V4-SEC-014, V4-SEC-015, V4-OBS-011 |
| V4-PKG-001 | extension | V4 | queued | FluxLattice Standalone Crate + CLI Surface | V4-SETTLE-006, V4-SETTLE-007, V4-RUST-003 |
| V4-PKG-002 | launch-polish | V4 | queued | Internal Tool Framing Pack (`README` + `CHANGELOG` + `internal-ci`) | V4-PKG-001, V4-FORT-007, V4-AESTHETIC-002 |
| V4-PKG-003 | extension | V4 | queued | FluxLattice Migration & Adoption Bridge (`protheusctl migrate`) | V4-PKG-001, V4-SCALE-007, V4-SETTLE-002 |
| V4-LENS-006 | launch-polish | V4 | queued | Optional Hidden Lens Mode + Selective Exposure | V4-AESTHETIC-002, V4-ILLUSION-001 |
| V4-PKG-004 | launch-polish | V4 | queued | LensMap Standalone Internal Tool Repository | V4-LENS-006, V4-PKG-003, V4-FORT-007 |
| V4-PKG-005 | extension | V4 | queued | LensMap Boilerplate Simplification Suite | V4-PKG-004, V4-LENS-006 |
| V4-PKG-006 | launch-polish | V4 | queued | LensMap Internal Narrative + Release Polish | V4-PKG-004, V4-PKG-005, V4-AESTHETIC-002 |
| V4-PKG-007 | extension | V4 | queued | LensMap Adoption Bridge (Import + Sync + Toolchain Fit) | V4-PKG-004, V4-PKG-005, V4-PKG-003 |
| V4-SUITE-001 | extension | V4 | queued | `protheus-graph` Deterministic Workflow Engine | V4-SCALE-003, V4-SEC-014, V4-PKG-003 |
| V4-SUITE-002 | extension | V4 | queued | `protheus-mem` Long-Memory CLI Surface | V3-RACE-023, V4-SCI-008, V4-PKG-003 |
| V4-SUITE-003 | launch-polish | V4 | queued | `protheus-telemetry` Trace + Sovereignty Export CLI | V4-OBS-011, V4-SCALE-008, V4-PKG-003 |
| V4-SUITE-004 | hardening | V4 | queued | `protheus-vault` Zero-Knowledge Secrets CLI | V4-SCALE-009, V4-SEC-015, V4-PKG-003 |
| V4-SUITE-005 | extension | V4 | queued | `protheus-swarm` Multi-Agent Coordination CLI | V4-SCALE-003, V4-SCALE-007, V4-PKG-003 |
| V4-SUITE-006 | hardening | V4 | queued | `protheus-redlegion` Adversarial Operations CLI | V3-RACE-DEF-027, V3-RACE-DEF-031B, V4-PKG-003 |
| V4-SUITE-007 | extension | V4 | queued | `protheus-forge` Productization Uplift | V4-SCI-006, V4-PKG-001, V4-PKG-003 |
| V4-SUITE-008 | launch-polish | V4 | queued | `protheus-bootstrap` Scaffolding CLI | V4-UX-001, V4-PKG-003, V4-PKG-005 |
| V4-SUITE-009 | extension | V4 | queued | `protheus-econ` Unit-Economics CLI | V4-SCALE-010, V5-RUST-PROD-012, V4-PKG-003 |
| V4-SUITE-010 | launch-polish | V4 | queued | `protheus-soul` Public Export Mode | V4-ILLUSION-001, V4-AESTHETIC-002, V4-PKG-003 |
| V4-SUITE-011 | launch-polish | V4 | queued | `protheus-pinnacle` CLI Polish + Operability Pack | V4-OBS-011, V4-PKG-003, V4-SCALE-008 |
| V4-SUITE-012 | hardening | V4 | queued | Suite Governance Pack (Naming, Contracts, npm Hooks, CI Gates) | V4-SUITE-001, V4-SUITE-011, V4-PKG-002 |
| V4-BRAND-001 | launch-polish | V4 | queued | Protheus Labs Org Identity Sweep | V4-FORT-007, V4-PKG-002 |
| V4-BRAND-002 | hardening | V4 | queued | Legacy Identity Purge Gate | V4-BRAND-001, V4-SUITE-012 |
| V4-TRUST-001 | hardening | V4 | queued | Git Provenance Integrity Guardrail (No History Rewrite on Protected Branches) | V4-SUITE-012, V4-SEC-014 |
| V4-REL-001 | extension | V4 | queued | Release Provenance Pipeline (Signed Tags + Changelog Evidence) | V4-TRUST-001, V4-PKG-002, V4-OBS-011 |
| V4-ROLL-001 | scale-readiness | V4 | queued | First-Wave Tool Rollout Sequencer (`graph/mem/telemetry/vault`) | V4-SUITE-001, V4-SUITE-002, V4-SUITE-003, V4-SUITE-004, V4-SUITE-012 |
| V4-DOC-ORG-001 | launch-polish | V4 | queued | Org-Level README + Onboarding Narrative Refresh | V4-BRAND-001, V4-FORT-007, V4-SUITE-012 |

