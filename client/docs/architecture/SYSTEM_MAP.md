# System Map

Generated: 2026-03-08T20:10:59.389Z

This map is generated from `client/config/system_map_registry.json` via `system_map_generator` and is the canonical quick-reference for subsystem purpose, ownership, and health checks.

## Layer Coverage

| Layer | Subsystems |
|---|---:|
| Layer -1 | 1 |
| Layer 0 | 5 |
| Layer 2 | 1 |
| Cross-Plane | 1 |
| Client Ops | 2 |
| Client Cognition | 10 |

## Subsystem Map

| Subsystem | Layer | Purpose | Owner | Inputs | Outputs | Failure Mode | Health Check | SRS |
|---|---|---|---|---|---|---|---|---|
| Exotic Wrapper | Layer -1 | Normalizes exotic substrate signals into deterministic Layer 0 envelopes. | core | substrate probes; adapter capability metadata | layer0 envelope; degradation contract | unsupported_substrate_profile | `cargo check -p exotic_wrapper` | `V6-ARCH-LAYERING-031` |
| Adaptive Runtime (Core) | Layer 0 | Owns adaptation cadence/resource contracts and emits deterministic adaptation receipts. | core | adaptive tick; runtime metrics | adaptation receipt; status snapshot | adaptive_policy_guard_denied | `protheus-ops adaptive-runtime status` | `V6-ADAPT-CORE-001` |
| Attention Queue | Layer 0 | Maintains TTL/dedupe/backpressure-governed priority event queue. | core | eyes; memory auto-recall; dopamine; spine; shadow dispatch | priority-ordered events; cursor/ack receipts | queue_backpressure_or_gate_active | `protheus-ops attention-queue status` | `V6-COCKPIT-002`, `V6-COCKPIT-006`, `V6-INITIATIVE-013` |
| Global Importance Kernel | Layer 0 | Scores cross-system events and assigns deterministic priority/initiative actions. | core | attention queue event; severity and context metadata | score; band; priority; initiative_action | layer2_priority_authority_unavailable | `npm run -s ops:test:protheus-ops-core:attention` | `V6-INITIATIVE-013` |
| Origin Integrity | Layer 0 | Enforces infallible-origin checks before autonomous runtime actions. | core | startup self-audit; manual origin verify | origin integrity receipt; degraded/fail-closed decision | origin_integrity_timeout_or_mismatch | `protheus-ops origin-integrity status` | `V6-ORIGIN-001`, `V6-ORIGIN-004` |
| Swarm Router | Layer 0 | Provides typed task routing with retry, scaling, and queue contracts. | core | coordinator tasks; worker status | route decisions; in-flight metrics; recovery receipts | cargo_test_timeout_host_stall | `cargo test -p swarm_router` | `V6-SWARM-001`, `V6-SWARM-006` |
| Initiative Primitives | Layer 2 | Provides deterministic initiative score/action primitives for cockpit-safe proactive behavior. | core | importance payload; attention metadata | initiative action; priority shaping | layer2_execution_lane_unavailable | `npm run -s ops:test:execution-core:initiative` | `V6-ARCH-ICEBERG-028`, `V6-INITIATIVE-013` |
| Conduit Bridge | Cross-Plane | Enforces conduit-only communication between client surfaces and core authority. | core+client | client lane request; daemon probes | typed conduit response; runtime gate diagnostics | conduit_stdio_timeout_or_runtime_gate | `node client/lib/conduit_full_lifecycle_probe.js` | `V6-COCKPIT-005`, `V6-CONDUIT-RUNTIME-STALL-001` |
| Cockpit Harness | Client Ops | Surfaces critical ambient alerts and cockpit-ready telemetry for mech-suit operation. | client | daemon status; alert events | cockpit alert artifacts; harness receipts | alert_publish_failed | `node client/systems/ops/cockpit_harness.js status` | `V6-MECH-014` |
| Persistent Cockpit Daemon | Client Ops | Attach-first daemon that keeps ambient loop, subscribe lane, and resident state alive across sessions. | client | attach/start/subscribe commands; attention queue drain | status envelopes; degraded class diagnostics; subscribe batches | bridge_degraded_or_origin_pending | `node client/systems/ops/protheusd.js status` | `V6-COCKPIT-001`, `V6-COCKPIT-004`, `V6-COCKPIT-005` |
| Browser Text/Diff Lane | Client Cognition | Emits token-efficient browser text snapshots and compact diffs instead of heavy payloads. | client | html/text snapshot; before/after text | text snapshot receipt; diff receipt with token reduction | snapshot_parse_failed | `npm run -s test:lane:v6-browser-007` | `V6-BROWSER-007` |
| Conversation Eye | Client Cognition | Synthesizes dialogue into tagged memory nodes and forwards recall triggers. | client | session messages | conversation nodes; auto-recall triggers | synthesis_write_failed | `npm run -s test:ops:conversation-eye-collector` | `V6-COGNITION-010` |
| Dream Sequencer | Client Cognition | Periodically reorders memory relevance and refreshes top-priority recall surfaces. | client | memory matrix | reordered priorities; dream sequence receipts | dream_cycle_degraded | `npm run -s memory:dream-sequencer:status` | `V6-MEMORY-011` |
| Eyes/Sensory Intake | Client Cognition | Collects external signals and routes governed events to memory/attention lanes. | client | collectors; eye directives | signal events; memory bridge entries | collector_failure_or_route_denied | `node client/systems/sensory/eyes_intake.js status` | `V6-SHADOW-003` |
| Low-Burn Reflexes | Client Cognition | Provides capped helper reflexes for common tasks without large token overhead. | client | reflex request | bounded reflex response | token_cap_violation | `npm run -s test:reflexes` | `V6-REFLEX-CORE-001` |
| Memory Auto-Recall | Client Cognition | Pushes bounded high-overlap memory matches into attention without full-file scans. | client | new memory node; tag overlap matrix | attention queue enqueue | attention_enqueue_failed | `npm run -s test:memory:auto-recall` | `V6-MEMORY-011` |
| Memory Matrix | Client Cognition | Maintains scored tag-to-memory index for low-burn retrieval and ranking. | client | daily nodes; conversation eye; dream flags | ranked matrix entries; tag coverage | matrix_rebuild_failed | `npm run -s test:memory:matrix` | `V6-MEMORY-011` |
| Realtime Adaptation Loop | Client Cognition | Applies interaction-driven adaptation under drift/covenant gates with continuity checks. | client | interaction/heartbeat triggers; resource metrics | adaptation cycle receipts; review bridge submissions | cadence_throttle_or_drift_gate | `npm run -s test:lane:v6-adapt-004` | `V6-ADAPT-004`, `V6-ADAPT-005`, `V6-ADAPT-006` |
| Shadow Dispatch Reliability | Client Cognition | Provides idempotent enqueue/retry/ack dispatch contract for routed shadow tasks. | client | classifier route; dispatch request | dispatch queue state; escalation/ack receipts | dispatch_queue_stall | `npm run -s test:lane:v6-shadow-004` | `V6-SHADOW-004` |
| Shadow Signal Classifier | Client Cognition | Classifies sensory signals into shadow routes with confidence and reason receipts. | client | eye signals | shadow route map; classifier receipt | no_route_match | `npm run -s test:lane:v6-shadow-003` | `V6-SHADOW-003` |

