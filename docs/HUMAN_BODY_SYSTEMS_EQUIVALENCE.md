# Human Body Systems vs Protheus: Capability Equivalence Map

Purpose: map major human biological systems/capabilities to current system equivalents, identify missing equivalents, and surface new upgrade angles.

Date: 2026-02-22

## Legend

- `Strong`: clear equivalent exists and is operating.
- `Partial`: equivalent exists but is shallow/incomplete.
- `Missing`: no direct equivalent yet.

## 1) Major Body Systems

| Human System | Core Biological Function | Current Protheus Equivalent | Status | Key Gap / Angle |
|---|---|---|---|---|
| Nervous System (CNS/PNS) | Global coordination, decision and control | `systems/spine/spine.js`, `systems/routing/model_router.js`, `systems/autonomy/autonomy_controller.js` | Strong | Improve higher-order arbitration under conflicting objectives. |
| Sensory System | Capture external/internal signals | `habits/scripts/external_eyes.js`, `systems/sensory/collector_driver.js`, `systems/sensory/focus_controller.js`, `systems/sensory/temporal_patterns.js` | Strong | Internal sensing is still weaker than external sensing. |
| Endocrine System | Slow global modulation (state/hormones) | Directive pulse + strategy mode + budget pressure (`systems/autonomy/*`, `systems/budget/system_budget.js`) | Partial | Add one unified "global state modulator" instead of scattered knobs. |
| Cardiovascular System | Reliable transport/distribution | Sensory queue + proposal flow + routing/actuation pipelines (`habits/scripts/sensory_queue.js`, `systems/actuation/bridge_from_proposals.js`) | Partial | Add explicit QoS lanes and flow-control guarantees end-to-end. |
| Respiratory System | Oxygen intake / exchange for energy production | Model/runtime availability checks and fallback across local/cloud (`systems/routing/model_router.js`, `systems/security/llm_gateway_guard.js`) | Partial | Needs stronger auto-failover + warm pools under degraded model conditions. |
| Digestive System | Ingest, break down, extract nutrients | Collectors -> insight -> queue -> enrich -> memory bridge (`habits/scripts/eyes_insight.js`, `systems/autonomy/proposal_enricher.js`, `systems/memory/eyes_memory_bridge.js`) | Strong | Improve "nutrient extraction" quality scoring before queue growth. |
| Urinary/Excretory System | Waste removal and toxin control | Queue/state cleanup and compaction (`habits/scripts/queue_gc.js`, `systems/ops/queue_log_compact.js`, `systems/ops/state_cleanup.js`) | Strong | Add stricter retention tiers to prevent silent state bloat recurrence. |
| Immune/Lymphatic System | Threat detection, isolation, response memory | Integrity + guards + attestation + quarantine (`systems/security/integrity_kernel.js`, `systems/security/startup_attestation.js`, `systems/security/skill_quarantine.js`) | Strong | Auto-generate prevention rules from repeated incidents (immune memory loop). |
| Integumentary System (skin/barrier) | Boundary protection and controlled exchange | Ingress/egress/security boundaries (`systems/security/request_ingress.js`, `systems/security/egress_gateway.js`, `systems/security/workspace_dump_guard.js`) | Strong | Add faster anomaly alarms for unusual external write/egress patterns. |
| Musculoskeletal System | Movement and work execution | Actuation + reflex/habit execution (`systems/actuation/actuation_executor.js`, `systems/reflex/reflex_dispatcher.js`, `habits/scripts/run_habit.js`) | Strong | Better precision control for safe high-frequency micro-actions. |
| Skeletal System | Structural stability and constraints | Contracts + schema + architecture guards (`systems/security/schema_contract_check.js`, `systems/security/architecture_guard.js`) | Strong | Increase mutation-time invariant checks before writes, not just after. |
| Reproductive/Developmental System | Growth, replication, adaptation | Adaptive layer evolution (`systems/adaptive/*_store.js`, `systems/autonomy/adaptive_crystallizer.js`, `systems/sensory/eyes_intake.js`) | Partial | Controlled "safe innovation sandbox" still limited; promotion criteria can be stricter. |

## 2) Cross-Cutting Human Capabilities

| Capability | Human Analogue | Current Equivalent | Status | Gap / Angle |
|---|---|---|---|---|
| Pain / Nociception | Immediate harm signaling | `systems/autonomy/pain_signal.js`, `systems/autonomy/pain_adaptive_router.js` | Strong | Expand pain -> prevention conversion rate measurement. |
| Wound Healing | Repair damaged function | Self-change failsafe and rollback (`systems/autonomy/self_change_failsafe.js`, `systems/autonomy/improvement_controller.js`) | Partial | Add transactional repair playbooks per subsystem, not generic only. |
| Homeostasis | Keep variables in safe range | Budget guard + mode guard + cooldowns + gates | Partial | Needs one unified homeostasis controller over CPU/RAM/tokens/queue pressure. |
| Attention Control | Focus on salient signal | Focus controller + pupil-like thresholding (`systems/sensory/focus_controller.js`) | Strong | Improve cross-eye focus transfer when multi-source convergence is detected. |
| Learning & Plasticity | Improve behavior from outcomes | Habits/reflex/strategy adaptive stores + outcome loops | Strong | Better causal attribution: what changed outcome quality and why. |
| Sleep & Consolidation | Compress experiences into memory | `systems/memory/memory_dream.js`, `systems/memory/idle_dream_cycle.js`, `systems/memory/creative_links.js` | Partial | Dream outputs need stronger upstream action linkage and quality gating. |
| Memory Recall | Retrieve relevant prior state quickly | UID graph + pointer bridges (`systems/memory/uid_connections.js`, `systems/memory/memory_recall.js`) | Strong | Add adaptive forgetting weights tied to retrieval utility, not age only. |
| Interoception | Sense internal body condition | Partial via health/status checks (`systems/autonomy/health_status.js`) | Partial | Build continuous internal telemetry layer (CPU/RAM/disk/network latency). |
| Proprioception | Know body position/effector state | Partial via leases/spawn/runtime status (`systems/spawn/spawn_broker.js`, `systems/security/capability_lease.js`) | Partial | Add real-time "where are my active workers and what are they doing" map. |
| Circadian Rhythm | Time-based behavior modulation | Heartbeat/cron + cooldown intervals | Partial | Add time-of-day strategy bands (explore/exploit/sleep-depth windows). |
| Immune Memory | Faster response to known threats | Incident logs and guards | Partial | Convert repeated failure signatures into automatic preventive policy updates. |
| Reproduction of Useful Traits | Pass winning patterns forward | Adaptive crystallization into habits/reflex | Partial | Add "promotion confidence" math with reversible trial windows by default. |

## 3) Missing or Weak Equivalents (Highest Leverage)

1. Unified homeostasis controller
- Missing single controller that balances token budget, queue load, model latency, spawn pressure, and system resources together.

2. Continuous interoception layer
- Internal state sensing is episodic; needs streaming telemetry for CPU/RAM/disk/network/model latency and utilization trends.

3. Immune memory auto-hardening
- Failures are logged well, but repeated failures should produce deterministic preventive patches/policies automatically.

4. Dream-to-action conversion
- Dreaming/consolidation exists, but promotion from dream insight -> concrete experiment/proposal can be tighter.

5. Proprioceptive execution map
- Need a single live control-plane view of active cells/workers/habits, lease status, and in-flight risk.

## 4) New Angles to Improve the System (General, Non-Specialized)

1. Build `systems/homeostasis/homeostasis_controller.js`
- Input: budget pressure, routing degradation, queue depth, spawn saturation, error rates, telemetry.
- Output: global throttles for autonomy, focus threshold, reflex cell cap, dream depth, and model escalation policy.

2. Add `systems/telemetry/interoception_stream.js`
- Deterministic periodic internal sensing with compact EMA metrics and anomaly flags.
- Feed directly into health status, routing, and homeostasis controller.

3. Add immune-memory policy synthesis
- Convert recurrent pain/failure signatures into candidate policy deltas with expiry and rollback.
- Route through existing governance gates (no direct auto-apply).

4. Add dream-action bridge
- For each dream quantized link above threshold, auto-generate bounded "micro-experiment proposals" with clear success criteria.

5. Add proprioception dashboard
- Real-time snapshot: what is running, what is blocked, what is cooling down, and what is lease-limited.

## 5) Summary

The system already has strong equivalents for sensing, control, protection, execution, and adaptive learning.  
The biggest frontier is not adding more organs; it is integrating existing organs under tighter global physiology: homeostasis + interoception + immune memory + dream-to-action closure.

