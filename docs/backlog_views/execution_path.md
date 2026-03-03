# Backlog Execution Path

Generated: 2026-03-03T02:01:01.449Z

## Summary

- Queued rows: 205
- Lane run commands discovered: 103
- Lane coverage (queued rows with lane): 5.37%
- Runnable now (lane + deps closed): 5
- Runnable but blocked by deps: 6
- Ready but no lane implementation: 33
- Blocked + no lane implementation: 161

## Recommended Next Actions

- Execute 5 runnable rows with existing lane commands first (lane:<id>:run + corresponding test:lane:<id>).
- For 33 dependency-ready rows without lanes, add runtime lane + test artifacts before marking done.
- Prioritize blocker dependencies (V3-RACE-031:7, V3-RACE-137:7, V3-RACE-200:6, V3-RACE-212:6, V3-RACE-223:6, V3-RACE-245:6, V4-SETTLE-001:6, V3-RACE-201:5, V3-RACE-249:5, V3-RACE-250:5) to unlock blocked rows fastest.

## Runnable Now

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V3-RACE-DEF-027 | V3 | extension | yes |  | Project Jigsaw (AttackCinema Incident Replay Theater) |
| V3-RACE-038A | V3 | extension | yes |  | Inter-Protheus Federation Trust Web & Temporary Merge Contracts |
| V3-RACE-040 | V3 | hardening | yes |  | Continuous Chaos Engineering + Auto-Remediation Suite |
| V3-RACE-058 | V3 | extension | yes |  | Legal/Regulatory Auto-Diff Governance Router |
| V3-RACE-059 | V3 | hardening | yes |  | Sovereign Decommission, Legacy & Succession Boundary Protocol |

## Ready But Missing Lane Implementation

| ID | Wave | Class | Lane | Open Dependencies | Title |
|---|---|---|---|---|---|
| V4-OBS-011 | V4 | launch-polish | no |  | Advanced `protheus-top` observability dashboard polish |
| V4-SETTLE-001 | V4 | primitive-upgrade | no |  | Core Settling Engine (Compile + Memory-Map + Re-exec) |
| V4-SCALE-002 | V4 | scale-readiness | no |  | Stateless App-Tier + Horizontal Autoscaling Contract |
| V4-SCALE-003 | V4 | scale-readiness | no |  | Durable Async Pipeline (Queue/Retry/Idempotency/Backpressure) |
| V4-SCALE-004 | V4 | scale-readiness | no |  | Data Plane Scale Program (Partitioning + Read/Write Split + Online Migration) |
| V4-SCALE-005 | V4 | scale-readiness | no |  | Caching + Edge Delivery Contract (CDN + Hot-Key + Invalidation) |
| V4-SCALE-007 | V4 | scale-readiness | no |  | Release Safety at Scale (Canary + Feature Flags + Schema Compatibility) |
| V4-SCALE-008 | V4 | scale-readiness | no |  | Observability + SRE Operations Maturity Pack |
| V4-SCALE-009 | V4 | scale-readiness | no |  | Abuse/Security Hardening at Scale (Rate-Limit + Tenant Isolation + Auth) |
| V4-SCALE-010 | V4 | scale-readiness | no |  | Capacity + Unit Economics Governance (p95/p99 + Cost per User) |
| V3-RACE-064 | V3 | primitive-upgrade | no |  | Sync-Spawn Hotspot Reduction Wave (Worker/Daemon Shift) |
| V3-RACE-103 | V3 | hardening | no |  | Sensitivity/Privacy-Aware Signal Scoring Contract |
| V3-RACE-131 | V3 | extension | no |  | Seed Spawn Lineage + Inheritance Contracts |
| V3-RACE-132 | V3 | extension | no |  | Civic Duty Allocation Engine (User-Governed Public-Good Cycles) |
| V3-RACE-133 | V3 | extension | no |  | Peer GPU Lending Marketplace (Governed, Contract-Bound) |
| V3-RACE-137 | V3 | primitive-upgrade | no |  | CRDT Local-First State Plane (Soul/Memory/Contract Domains) |
| V3-RACE-139 | V3 | extension | no |  | Intent Declaration + Translation Plane |
| V3-RACE-140 | V3 | extension | no |  | DID + Verifiable Credential Soul Binding Layer |
| V3-RACE-167 | V3 | primitive-upgrade | no |  | System-3 Executive Layer (Growth Journal + Intrinsic Goal Loop) |
| V3-RACE-207 | V3 | hardening | no |  | Budget Envelope Partitioning (Execution Floor vs Dream/Idle Burn) |
| V3-RACE-212 | V3 | extension | no |  | Universal Platform Abstraction Matrix (18 GENERAL Requirements) |
| V3-RACE-224 | V3 | extension | no |  | Sovereign Microsoft Model Routing Profile (Phi-4 Local Default + Private Azure Fallback + Entra Binding) |
| V3-RACE-233 | V3 | primitive-upgrade | no |  | AWS Accelerator HAL Adapter (Neuron/Trainium/Inferentia + Nitro Metadata Placement) |
| V3-RACE-243 | V3 | extension | no |  | CloudWatch/X-Ray Observability Bridge + Tauri Dashboard Embed |
| V3-RACE-248 | V3 | extension | no |  | Apple Silicon Performance Profile (Unified Memory + Power-Aware Runtime) |
| V3-RACE-263 | V3 | primitive-upgrade | no |  | Google TPU/Tensor Accelerator Adapter (TPU v5p/Trillium/EdgeTPU/Coral + Vertex Path) |
| V3-RACE-303 | V3 | extension | no |  | IBM Mainframe Runtime Parity Pack (LinuxONE/IBM Z + RAS Contracts) |
| V3-RACE-308 | V3 | hardening | no |  | IBM Formal Methods Gate Adapter (Z/TLA+/Alloy/CPLEX) |
| V3-RACE-333 | V3 | hardening | no |  | SELinux Enforcing-By-Default Policy Pack (Per-Lane Least Privilege) |
| V3-RACE-347 | V3 | extension | no |  | NixOS Declarative Adaptation Pack (Modules/Flakes/Impermanence/Hydra/Cachix) |
| V3-RACE-348 | V3 | extension | no |  | Raspberry Pi OS Edge Hardware Adaptation Pack (GPIO/Boot/Firmware/Provisioning/OTA) |
| V3-RACE-349 | V3 | extension | no |  | Alpine Minimal-Hardening Adaptation Pack (musl/apk/rootless scratch/read-only overlay) |
| V3-RACE-356 | V3 | primitive-upgrade | no |  | PlatformSocket ABI + Signed Manifest Contract |

## Top Dependency Blockers

| Dependency | Blocked Rows |
|---|---|
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
| V3-RACE-315 | 4 |
| V3-RACE-345 | 4 |
| V4-SETTLE-006 | 4 |
| V3-RACE-041 | 3 |
| V3-RACE-058 | 3 |
| V3-RACE-133 | 3 |
| V3-RACE-153 | 3 |
| V3-RACE-164 | 3 |
| V3-RACE-167 | 3 |
| V3-RACE-181 | 3 |
| V3-RACE-224 | 3 |
| V3-RACE-248 | 3 |
| V3-RACE-261 | 3 |
| V3-RACE-277 | 3 |
| V3-RACE-287 | 3 |
| V3-RACE-291 | 3 |
| V3-RACE-297 | 3 |
| V3-RACE-303 | 3 |
| V3-RACE-309 | 3 |
| V3-RACE-311 | 3 |
| V3-RACE-343 | 3 |
| V3-RACE-348 | 3 |
| V3-RACE-356 | 3 |
| V4-SETTLE-005 | 3 |
| V4-SETTLE-011 | 3 |
| V3-RACE-040 | 2 |
| V3-RACE-131 | 2 |
| V3-RACE-136 | 2 |
| V3-RACE-138 | 2 |
| V3-RACE-140 | 2 |
| V3-RACE-142 | 2 |
| V3-RACE-145 | 2 |
| V3-RACE-146 | 2 |
| V3-RACE-147 | 2 |
| V3-RACE-149 | 2 |
| V3-RACE-154 | 2 |
| V3-RACE-155 | 2 |
| V3-RACE-156 | 2 |
| V3-RACE-158 | 2 |
| V3-RACE-166 | 2 |
| V3-RACE-168 | 2 |
| V3-RACE-171 | 2 |
| V3-RACE-177 | 2 |
| V3-RACE-178 | 2 |
| V3-RACE-225 | 2 |
| V3-RACE-226 | 2 |
| V3-RACE-236 | 2 |
| V3-RACE-241 | 2 |
| V3-RACE-243 | 2 |
| V3-RACE-251 | 2 |
| V3-RACE-253 | 2 |
| V3-RACE-254 | 2 |
| V3-RACE-257 | 2 |
| V3-RACE-264 | 2 |
| V3-RACE-271 | 2 |
| V3-RACE-275 | 2 |
| V3-RACE-279 | 2 |
| V3-RACE-284 | 2 |
| V3-RACE-285 | 2 |
| V3-RACE-300 | 2 |
| V3-RACE-306 | 2 |
| V3-RACE-313 | 2 |
| V3-RACE-338 | 2 |
| V3-RACE-341 | 2 |
| V3-RACE-357 | 2 |
| V3-RACE-DEF-027 | 2 |
| V4-SETTLE-003 | 2 |
| V4-SETTLE-007 | 2 |
| V3-RACE-057 | 1 |
| V3-RACE-064 | 1 |
| V3-RACE-132 | 1 |
| V3-RACE-139 | 1 |
| V3-RACE-143 | 1 |
| V3-RACE-148 | 1 |
| V3-RACE-150 | 1 |
| V3-RACE-157 | 1 |
| V3-RACE-159 | 1 |
| V3-RACE-160 | 1 |
| V3-RACE-176 | 1 |
| V3-RACE-192 | 1 |
| V3-RACE-246 | 1 |
| V3-RACE-247 | 1 |
| V3-RACE-252 | 1 |
| V3-RACE-266 | 1 |
| V3-RACE-267 | 1 |
| V3-RACE-288 | 1 |
| V3-RACE-290 | 1 |
| V3-RACE-292 | 1 |
| V3-RACE-293 | 1 |
| V3-RACE-294 | 1 |
| V3-RACE-296 | 1 |
| V3-RACE-301 | 1 |
| V3-RACE-302 | 1 |
| V3-RACE-305 | 1 |
| V3-RACE-308 | 1 |
| V3-RACE-310 | 1 |

