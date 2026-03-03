# Backlog Execution Path

Generated: 2026-03-03T01:53:59.749Z

## Summary

- Queued rows: 238
- Lane run commands discovered: 71
- Lane coverage (queued rows with lane): 5.04%
- Runnable now (lane + deps closed): 4
- Runnable but blocked by deps: 8
- Ready but no lane implementation: 30
- Blocked + no lane implementation: 196

## Recommended Next Actions

- Execute 4 runnable rows with existing lane commands first (lane:<id>:run + corresponding test:lane:<id>).
- For 30 dependency-ready rows without lanes, add runtime lane + test artifacts before marking done.
- Prioritize blocker dependencies (V3-RACE-218:10, V3-RACE-129:9, V4-SCALE-001:9, V3-RACE-044:8, V3-RACE-130:8, V3-RACE-211:8, V3-RACE-031:7, V3-RACE-137:7, V3-RACE-200:6, V3-RACE-212:6) to unlock blocked rows fastest.

## Runnable Now

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V3-RACE-DEF-027 | V3 | extension | yes |  | Project Jigsaw (AttackCinema Incident Replay Theater) |
| V3-RACE-038A | V3 | extension | yes |  | Inter-Protheus Federation Trust Web & Temporary Merge Contracts |
| V3-RACE-040 | V3 | hardening | yes |  | Continuous Chaos Engineering + Auto-Remediation Suite |
| V3-RACE-059 | V3 | hardening | yes |  | Sovereign Decommission, Legacy & Succession Boundary Protocol |

## Ready But Missing Lane Implementation

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V4-AUTO-010 | V4 | launch-polish | no |  | Autogenesis trust + reversibility UX layer |
| V3-RACE-022 | V3 | extension | no |  | Compute-Tithe Flywheel (Tithe-as-Leverage GPU Donation System) |
| V3-RACE-061 | V3 | hardening | no |  | Deterministic Time Harness for Release/TTL Gates |
| V3-RACE-063 | V3 | primitive-upgrade | no |  | Warm-Path Rust Benchmark Lane (Daemon/Binary, No Cargo-Compile Tax) |
| V3-RACE-065 | V3 | primitive-upgrade | no |  | Rust Memory Vector Retrieval Activation (Hot-Path Similarity Search) |
| V3-RACE-CONF-008 | V3 | hardening | no |  | Merge-Conflict Marker CI Guard (`<<<<<<<`, `=======`, `>>>>>>>`) |
| V3-RACE-077 | V3 | hardening | no |  | Adaptive Escalation TTL + Salvage Queue |
| V3-RACE-078 | V3 | hardening | no |  | Negative-Signal Recovery & Salvage Lane |
| V3-RACE-080 | V3 | hardening | no |  | Cross-Temporal Signal Delta Engine |
| V3-RACE-129 | V3 | primitive-upgrade | no |  | Soul Contracts Primitive (Immutable User Directive Ledger) |
| V3-RACE-134 | V3 | extension | no |  | Visual Dynamic Signature Engine (Identity Render Contract) |
| V3-RACE-141 | V3 | extension | no |  | Content-Addressed Archival Plane (IPFS-Compatible) |
| V3-RACE-196 | V3 | extension | no |  | Probationary Security Habit Apply + Promotion Loop |
| V3-RACE-204 | V3 | hardening | no |  | Preview-Horizon Success Criteria Contract (Deferred Metrics in Score-Only) |
| V3-RACE-205 | V3 | hardening | no |  | Deterministic Execution-Floor Bootstrap Lane (1 Shippable Outcome Minimum) |
| V3-RACE-206 | V3 | hardening | no |  | Score-Only Manual-Gate Exclusion & Selector Penalty |
| V3-RACE-208 | V3 | hardening | no |  | Model Health Stabilizer (Adaptive Probe Timeouts + Temporary Suppression/Rehab) |
| V3-RACE-211 | V3 | extension | no |  | Five-System Adaptation Channel Pack (Ubuntu/FreeBSD/NixOS/RaspberryPiOS/Alpine) |
| V3-RACE-213 | V3 | extension | no |  | Host Adaptation Operator Surface (`protheusctl host adapt`) + Auto-Activation |
| V3-RACE-215 | V3 | hardening | no |  | Architecture + Formal Spec Publication Kernel |
| V3-RACE-218 | V3 | primitive-upgrade | no |  | Cross-Platform Accelerator HAL (CPU/GPU/NPU Offload Contract) |
| V3-RACE-221 | V3 | hardening | no |  | Hot-Path Performance Multiplier Program (5-20x Guarded Targets) |
| V3-RACE-227 | V3 | extension | no |  | Enterprise Observability Surface (Azure Monitor + Desktop `protheus-top`) |
| V3-RACE-231 | V3 | extension | no |  | Public Roadmap Publication Contract (Backlog-Synchronized) |
| V3-RACE-260 | V3 | dependency-repair | no |  | Apple On-Device-First Sovereignty Gate (PCC-Only Cloud Exception) |
| V3-RACE-265 | V3 | hardening | no |  | Capability-Handle IPC Hardening Lane (Zircon-Inspired Contract) |
| V3-RACE-295 | V3 | hardening | no |  | Open Contribution Governance Pipeline (CLA + Community Vote + Upstream Automation) |
| V3-RACE-307 | V3 | hardening | no |  | Post-Quantum Cryptography Enforcement Lane (Kyber/Dilithium/Falcon) |
| V3-RACE-334 | V3 | dependency-repair | no |  | Linux Kernel Acceleration/Sandbox Primitive Lane (eBPF/io_uring/cgroupv2/Landlock) |
| V3-RACE-342 | V3 | extension | no |  | Secure RPM Repository + Delta Update Channel Lane |

## Top Dependency Blockers

| Dependency | Blocked Rows |
|---|---|
| V3-RACE-218 | 10 |
| V3-RACE-129 | 9 |
| V4-SCALE-001 | 9 |
| V3-RACE-044 | 8 |
| V3-RACE-130 | 8 |
| V3-RACE-211 | 8 |
| V3-RACE-031 | 7 |
| V3-RACE-137 | 7 |
| V3-RACE-200 | 6 |
| V3-RACE-212 | 6 |
| V3-RACE-223 | 6 |
| V3-RACE-245 | 6 |
| V4-SETTLE-001 | 6 |
| V3-RACE-201 | 5 |
| V3-RACE-249 | 5 |
| V3-RACE-250 | 5 |
| V3-RACE-269 | 5 |
| V3-RACE-280 | 5 |
| V3-RACE-022 | 4 |
| V3-RACE-041 | 4 |
| V3-RACE-161 | 4 |
| V3-RACE-165 | 4 |
| V3-RACE-172 | 4 |
| V3-RACE-203 | 4 |
| V3-RACE-222 | 4 |
| V3-RACE-229 | 4 |
| V3-RACE-239 | 4 |
| V3-RACE-258 | 4 |
| V3-RACE-263 | 4 |
| V3-RACE-270 | 4 |
| V3-RACE-283 | 4 |
| V3-RACE-304 | 4 |
| V3-RACE-309 | 4 |
| V3-RACE-315 | 4 |
| V3-RACE-345 | 4 |
| V4-SETTLE-006 | 4 |
| V3-RACE-058 | 3 |
| V3-RACE-133 | 3 |
| V3-RACE-134 | 3 |
| V3-RACE-153 | 3 |
| V3-RACE-164 | 3 |
| V3-RACE-167 | 3 |
| V3-RACE-181 | 3 |
| V3-RACE-224 | 3 |
| V3-RACE-227 | 3 |
| V3-RACE-248 | 3 |
| V3-RACE-261 | 3 |
| V3-RACE-277 | 3 |
| V3-RACE-287 | 3 |
| V3-RACE-291 | 3 |
| V3-RACE-297 | 3 |
| V3-RACE-303 | 3 |
| V3-RACE-311 | 3 |
| V3-RACE-343 | 3 |
| V3-RACE-348 | 3 |
| V3-RACE-356 | 3 |
| V4-SETTLE-005 | 3 |
| V4-SETTLE-011 | 3 |
| V3-RACE-040 | 2 |
| V3-RACE-131 | 2 |

