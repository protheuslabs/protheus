# V2 Grok Proposal Evaluation (2026-02-25)

Scope: evaluate seven organism-style proposals against current Protheus architecture and decide whether to implement now, defer, or reject.

## Decision Summary

1. Dream / Sleep Consolidation Phase
- Decision: `accept_now` (bounded mode)
- Why: Existing `memory_dream` + `idle_dream_cycle` already provide foundation. Added bounded consolidation can improve pattern compression with low risk.
- Guardrails: no direct actuation; proposal-only outputs; hard budget/time caps.

2. Symbiotic Mutualism Engine
- Decision: `accept_now` (proposal and lease mode)
- Why: Fits spawn/strategy architecture when treated as temporary capability overlays instead of permanent topology mutation.
- Guardrails: reversible leases, explicit TTL, governance receipts.

3. Internal Predator-Prey Ecology
- Decision: `accept_now` (shadow mode first)
- Why: Useful for pruning pressure signals if it cannot auto-delete or auto-disable critical paths.
- Guardrails: shadow recommendations only until reliability threshold is met.

4. Epigenetic Regulation Layer
- Decision: `accept_now`
- Why: High-value reversible adaptation layer that does not require structural mutation.
- Guardrails: TTL-based tags, policy-limited tag classes, immutable audit trail.

5. Pheromone / Chemical Signaling Layer
- Decision: `accept_now` (signed local channel)
- Why: Enables local coordination at low cost while preserving traceability.
- Guardrails: signed packets, TTL, per-lane rate limits, no direct security-control bypass.

6. Resonance / Harmonic Tuning
- Decision: `accept_now` (telemetry signal only)
- Why: Useful as a ranking/scheduling feature if treated as measured consensus signal, not magic actuator.
- Guardrails: bounded influence weights, confidence gating, no autonomous high-risk unlock.

7. Collective Unconscious / Archetype Pool
- Decision: `accept_now`
- Why: Matches memory graph goals and improves transfer learning across branches.
- Guardrails: provenance linkage, decay policy, objective-alignment tags, manual promotion for high-impact archetypes.

## Mapping to Backlog

- V2-024 System organism visualization cockpit: consume new organism overlays.
- V2-025 Fractal morph planner: parent for symbiosis + topology proposals.
- V2-026 Genome topology ledger: mutation lineage + rollback pointers.
- V2-027 Evolution arena: predator/prey and resonance signals feed promotion.
- V2-028 Adaptive mutation safety kernel expansion: hard safety envelope.
- V2-030 Recursive organism introspection map: substrate for all seven proposals.
- V2-031 Black-box hash ledger: compliance-grade evidence for adaptive actions.

## Non-Negotiable Safety Constraints

- No direct self-modification execution from dream/morph engines.
- Security and policy-root controls remain non-disableable by any adaptive lane.
- All new adaptive outputs are receipts with provenance + TTL + rollback pointer.
- Any high-impact promotion requires human or dual-control approval.
