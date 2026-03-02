# Backlog Archive View

Generated: 2026-03-02T02:41:49.905Z

| ID | Class | Wave | Status | Title | Dependencies |
|---|---|---|---|---|---|
| V3-OPS-004 | extension | V3 | done | Unified Protheus Control Plane CLI (`protheus`) | stop |
| V3-RMEM-002 | primitive-upgrade | V3 | done | Rust Index Builder Slice (Benchmark-Gated) | rust for default benchmark policy wiring. |
| V3-RMEM-005 | hardening | V3 | done | Memory Backend Selector + Fallback Guard (`js | Cross-language migration needs deterministic fail-safe behavior to avoid runtime instability |
| V3-RACE-024 | hardening | V3 | done | Daemon Soak Promotion Gate + Receipts (24-48h) | V3-RACE-023, RM-122 |
| V3-RACE-025 | hardening | V3 | done | Daemon Supervision + Stale PID/Socket Reaper | V3-RACE-023, V3-OPS-005 |
| V3-RACE-026 | hardening | V3 | done | Fallback Retirement Gate (JS Emergency-Only) | V3-RACE-024, V3-RMEM-006 |
| V3-RACE-027 | primitive-upgrade | V3 | done | Direct Memory Encryption Plane Integration (Replace DB Shim) | V3-RACE-023, V3-ENT-002 |
| V3-RACE-028 | primitive-upgrade | V3 | done | In-Process Rust Memory Binding Lane (`napi-rs`) | V3-RACE-024, V3-RACE-025 |
| V3-DEP-001 | hardening | V3 | done | Deterministic One-Line Installer + Signed Release Channel | sh + offline script variant) that verifies signed artifact + checksum/SBOM provenance before install, supports explicit version pinning, and fails closed on verification mismatch |
| V3-RACE-001 | primitive-upgrade | V3 | done | Rust Core Runtime Kernel Slice | V3-RMEM-001, V3-OPS-005, V3-OPS-006 |
| V3-RACE-002 | hardening | V3 | done | Wasmtime Capability Microkernel Lane | V3-OF-001, V3-CPY-006, V3-VENOM-000 |
| V3-RACE-003 | primitive-upgrade | V3 | done | Event-Sourced Control Plane + CQRS Materialized Views | V3-SK-001, V3-SK-002, V3-SK-007 |
| V3-RACE-004 | primitive-upgrade | V3 | done | Model Catalog + Live Routing Scoreboard Service | RM-121, V3-BUD-001, V3-ECO-001 |
| V3-RACE-005 | hardening | V3 | done | Thought-to-Action Trace Contract (Intent -> Model -> Tool -> Outcome) | V3-OBS-002, RM-005, V2-063 |
| V3-RACE-006 | primitive | V3 | done | Swarm Orchestration Runtime (Hierarchical + Election + Consensus) | V3-MAC-001, BL-011, RM-202 |
| V3-RACE-007 | extension | V3 | done | Cross-Cell Memory Exchange Plane (Policy-Governed) | V3-MLC-002, V2-062, V3-GOV-002 |
| V3-RACE-008 | primitive-upgrade | V3 | done | Sovereign Personality Substrate ("Soul Vector") | V2-058, V3-SYM-001, V3-BLK-001 |
| V3-RACE-009 | primitive-upgrade | V3 | done | Hybrid Memory Engine (Vector + Graph + Temporal) | V3-MEM-001, V3-MEM-002, V3-053 |
| V3-RACE-010 | extension | V3 | done | Memory Consolidation + Forgetting Curves | V3-MEM-004, V3-MEM-008, V3-ASSIM-004 |
| V3-RACE-011 | extension | V3 | done | Habit/Objective Adapter Fine-Tuning Lane | V3-ASSIM-004, V3-XAI-002, V3-038 |
| V3-RACE-012 | hardening | V3 | done | Observability Deployment Defaults (Prometheus/Grafana/Loki/Trace) | RM-005, V3-OBS-002, V3-DEP-001 |
| V3-RACE-013 | extension | V3 | done | Compatibility Spec + Conformance Badge Program | V3-DOC-004, V3-BENCH-001, V3-OF-008 |
| V3-RACE-014 | primitive-upgrade | V3 | done | Risk-Tier Chain Bridge for Model Catalog Loop (`cheap -> deep -> critique`) | V3-RACE-004, V3-BUD-001, V3-AEX-001 |
| V3-RACE-015 | extension | V3 | done | JetStream Mirror Adapter for Event-Sourced Control Plane | V3-RACE-003, V3-SK-001, RM-202 |
| V3-RACE-016 | extension | V3 | done | Open Platform Layer Release Pack (Apache 2.0 non-crown-jewel + Compatibility Launch) | V3-RACE-013, V3-DOC-006, V3-BENCH-001, V3-OF-008 |
| V3-RACE-017 | primitive-upgrade | V3 | done | Authoritative Event-Stream Cutover (JetStream-First CQRS Authority) | V3-RACE-003, V3-RACE-015, RM-202, V3-SK-007 |
| V3-RACE-018 | extension | V3 | done | Trace-to-Habit Autogenesis Loop | V3-RACE-005, V2-020, V3-038, V3-ACT-001 |
| V3-RACE-019 | primitive | V3 | done | Persistent Fractal Engine Meta-Organ (Loop-5 Autopilot) | V3-LOOP-004, V3-038, V3-RACE-004, V3-RACE-010 |
| V3-RACE-020 | extension | V3 | done | LoRA-Backed Soul Continuity Adapter | V3-RACE-008, V3-ASSIM-012, V2-058, V3-BLK-001 |
| V3-RACE-021 | primitive-upgrade | V3 | done | Rust Microkernel Full Control-Plane Extraction + Default Cutover | V3-RACE-001, V3-RACE-002, V3-RMEM-006, RM-122, V3-OPS-015 |
| V3-RACE-022 | extension | V3 | done | Compute-Tithe Flywheel (Tithe-as-Leverage GPU Donation System) | V3-RACE-016, V3-RACE-017, V3-RACE-019, V3-BLK-001, V3-BUD-001 |
| V3-RACE-CONF-001 | extension | V3 | done | Open Platform Path-Contract Compatibility Pack (`platform/` artifacts) | V3-RACE-016, V3-DOC-001 |
| V3-RACE-CONF-002 | hardening | V3 | done | Legacy Path Alias Adapters (`systems/state/event_stream.js`, `systems/autogenesis/*`) | V3-RACE-017, V3-RACE-018 |
| V3-RACE-CONF-003 | hardening | V3 | done | Requirement Conformance Matrix + Gate (`external prompt -> canonical lane`) | V3-AEX-002, V3-DOC-004 |
| V3-RACE-CONF-004 | hardening | V3 | done | Rust Memory Path-Contract Compatibility (`core/memory` alias docs/wrappers) | V3-RACE-023, V3-DOC-001 |
| V3-RACE-CONF-005 | hardening | V3 | done | N-API Build Surface Compatibility Contract (`build:memory`/postinstall expectations) | V3-RACE-028, V3-DOC-004 |
| V3-RACE-DEF-024 | hardening | V3 | done | PsycheForge Adaptive Counter-Profile Defense Organ | V3-RACE-017, V3-RACE-019, V3-RACE-023, V3-VENOM-006 |
| V3-RACE-034 | primitive-upgrade | V3 | done | Rust Spine Microkernel (Control-Plane Core Extraction) | V3-RACE-023, V3-RACE-021, V3-OPS-005 |
| V3-RACE-037 | extension | V3 | done | Long-Term Archival & Sovereign Resurrection Substrate | V3-BLK-001, V3-QPROOF-001, V3-RACE-020 |
| V3-RACE-060 | hardening | V3 | done | Dist Runtime Contract Reconciliation Gate (Legacy-Pair Truth Source) | V2-003, BL-014, V3-AEX-002 |
| V3-RACE-061 | hardening | V3 | done | Deterministic Time Harness for Release/TTL Gates | V2-049, V2-050, V3-RACE-060 |
| V3-RACE-062 | hardening | V3 | done | Benchmark Artifact Consistency Gate (Report vs History vs Latest) | V3-RACE-024, V3-RACE-026 |
| V3-RACE-063 | primitive-upgrade | V3 | done | Warm-Path Rust Benchmark Lane (Daemon/Binary, No Cargo-Compile Tax) | V3-RACE-024, V3-RACE-025, V3-RACE-062 |
| V3-RACE-064 | primitive-upgrade | V3 | done | Sync-Spawn Hotspot Reduction Wave (Worker/Daemon Shift) | V3-OPS-005, V3-RACE-034, V3-RACE-063 |
| V3-RACE-065 | primitive-upgrade | V3 | done | Rust Memory Vector Retrieval Activation (Hot-Path Similarity Search) | V3-RACE-023, V3-RACE-028, V3-RACE-052 |
| V3-RACE-066 | hardening | V3 | done | Memory DB AEAD/Envelope Encryption Cutover | V3-RACE-027, V3-ENT-002, V3-RACE-023 |
| V3-RACE-067 | hardening | V3 | done | Memory Index Freshness Enforcement Gate | V3-RACE-023, V3-RACE-062, V3-RACE-CONF-007 |
| V3-RACE-068 | extension | V3 | done | Advisory JS Purge Wave (`habits/scripts`, `memory/tools`) | V2-001, V2-003, BL-014, RM-002 |
| V3-RACE-CONF-008 | hardening | V3 | done | Merge-Conflict Marker CI Guard (`<<<<<<<`, `=======`, `>>>>>>>`) | V3-RACE-CONF-007, V3-AEX-002 |
| V3-RACE-069 | hardening | V3 | done | Proposal Funnel SLO + Conversion Guard | RM-113, RM-114, BL-027 |
| V3-RACE-070 | primitive-upgrade | V3 | done | Top-K Execution Reservation Lane | BL-027, BL-018, V3-AEX-001 |
| V3-RACE-071 | hardening | V3 | done | Filter Pressure Rebalancer (High-Score Exemption Contracts) | BL-018, BL-027, RM-118 |
| V3-RACE-072 | extension | V3 | done | Action-Spec Auto-Enrichment Lane | BL-018, V3-017, V3-AEX-002 |
| V3-RACE-073 | hardening | V3 | done | Queue Debt Backpressure + Intake Throttle Mode | RM-114, BL-018, V3-RACE-069 |
| V3-RACE-074 | hardening | V3 | done | Eye Health SLO + Auto-Heal Escalation Lane | BL-026, V3-OPS-003, RM-118 |
| V3-RACE-075 | hardening | V3 | done | Execution Floor Contract (Sunday Included, Explicit Observation Override) | RM-113, V3-RACE-069, V3-AEX-001 |
| V3-RACE-076 | extension | V3 | done | Execution-to-Artifact Auto-Capture Bridge | BL-030, RM-113, V3-RACE-069 |
| V3-RACE-077 | hardening | V3 | done | Adaptive Escalation TTL + Salvage Queue | BL-018, RM-114, V3-RACE-073 |
| V3-RACE-078 | hardening | V3 | done | Negative-Signal Recovery & Salvage Lane | V3-RACE-069, V3-RACE-071, V3-RACE-072 |
| V3-RACE-079 | primitive-upgrade | V3 | done | Latent Intent Inference Graph | V3-RACE-078, V3-RACE-009 |
| V3-RACE-080 | hardening | V3 | done | Cross-Temporal Signal Delta Engine | V3-RACE-069, V3-RACE-074 |
| V3-RACE-081 | hardening | V3 | done | Confidence Calibration & Probability Contracts | V3-RACE-069, V3-RACE-062 |
| V3-RACE-106 | hardening | V3 | done | Unified Guard Check Registry (Manifest-Driven Gates) | V3-AEX-002, V3-RACE-CONF-008 |
| V3-RACE-107 | hardening | V3 | done | Shared Policy Runtime Primitive | BL-024, V3-RACE-CONF-007 |
| V3-RACE-108 | primitive-upgrade | V3 | done | Spawn Fan-Out Reduction Wave (Worker/Daemon Core) | V3-RACE-063, V3-RACE-064, V3-OPS-005 |
| V3-RACE-109 | hardening | V3 | done | State Artifact Contract Normalization | BL-024, V3-RACE-062, V3-RACE-CONF-007 |
| V3-RACE-110 | primitive-upgrade | V3 | done | Memory Transport Abstraction Unification | V3-RACE-023, V3-RACE-024, V3-RACE-025 |
| V3-RACE-111 | extension | V3 | done | Canonical Backlog Registry + Generated Views | V3-RACE-CONF-003, V3-RACE-107 |
| V3-RACE-113 | hardening | V3 | done | Compatibility Tail Retirement (TS-First Runtime) | V2-001, V2-003, BL-014, V3-RACE-068 |

