# Autonomy Physiology Roadmap (Plateau Breaker)

Purpose: translate the human-body equivalence model into concrete system upgrades that increase real autonomy, not metric artifacts.

Date: 2026-02-23

## Current Baseline (6-Month Harness)

- Raw: drift `0.242`, yield `0.429`, safety stops `0.019`
- Effective: drift `0.032`, yield `0.667`, safety stops `0.000`
- Persistent weak point: effective policy-hold pressure (`0.4`, warn state)

## Upgrade Tracks

1. Homeostasis Controller (`homeostasis_controller_v1`)
- Biology parallel: endocrine + homeostasis.
- Build: one global modulator over queue pressure, policy-hold pressure, token burn, route degradation, and safety pressure.
- Why now: policy-hold churn is the highest recurring pressure signature.
- Real-win test:
  - effective policy-hold rate down by at least `0.05`
  - effective drift down by at least `0.003`
  - absolute shipped count non-decreasing

2. Interoception Stream (`interoception_stream_v1`)
- Biology parallel: interoception.
- Build: continuous internal telemetry stream (CPU, RAM, disk, model latency, queue latency, token burn EMA).
- Why now: current health evaluation is episodic; we need predictive correction instead of reactive correction.
- Real-win test:
  - no increase in safety-stop rate
  - no increase in raw drift
  - reduction in emergency hold frequency

3. Immune Memory Synthesis (`immune_memory_synthesis_v1`)
- Biology parallel: immune memory.
- Build: recurrent failure patterns become bounded, reviewable policy candidates with TTL and rollback.
- Why now: we already harvest non-yield; promotion loop is still weak.
- Real-win test:
  - repeated failure signatures decline over matched horizon
  - at least one raw and one effective metric improve
  - no direct auto-apply to production policy files

4. Dream-to-Action Bridge (`dream_to_action_bridge_v1`)
- Biology parallel: consolidation -> motor planning.
- Build: convert high-confidence dream links into bounded micro-experiments with objective_id + success criteria.
- Why now: yield is decent but still below the 0.75 target zone.
- Real-win test:
  - effective yield up by at least `0.02`
  - no-progress rate down by at least `0.03`
  - queue spam controls remain active

5. Proprioception Control Plane (`proprioception_control_plane_v1`)
- Biology parallel: proprioception.
- Build: live map of active workers, leases, cooldowns, blocked routes, and in-flight risk.
- Why now: reduces blind execution and hidden contention.
- Real-win test:
  - queue pending ratio down
  - safety-stop rate down or unchanged
  - shipped throughput not reduced

6. Circulatory QoS Lanes (`circulatory_qos_lanes_v1`)
- Biology parallel: cardiovascular flow control.
- Build: explicit QoS lanes across proposal -> queue -> execution with lane pressure balancing.
- Why now: move from best-effort throughput to deterministic flow.
- Real-win test:
  - pending/total queue ratio down by at least `0.08`
  - yield up by at least `0.02`
  - no silent drops (all demotions/audits logged)

## Anti-Gaming Contract (Non-Negotiable)

1. Always publish raw and effective metrics together.
2. Keep harness policy and thresholds fixed during a feature trial.
3. Require absolute shipped-count non-regression over matched windows.
4. Reject denominator-only wins (attempt suppression without throughput improvement).
5. Stage one lever at a time with baseline -> candidate delta reports.

## Operating Loop

1. Run `npm run autonomy:physiology:map` to rank opportunities from latest simulation.
2. Pick one P1 opportunity as active lever.
3. Run `npm run impact:start -- --lever=<id>`.
4. Implement minimal testable slice.
5. Run full CI + 6-month harness.
6. Run `npm run impact:evaluate -- --lever=<id>`.
7. Promote only if gate passes and anti-gaming contract is satisfied.
