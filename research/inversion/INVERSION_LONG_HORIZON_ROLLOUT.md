# Inversion Rollout Plan (Human-Facing Research)

Date: 2026-02-26  
Status: Beta-safe plan. Runtime stays shadow-first by default.

## Current Operating Posture (Now)

- `shadow_only` stays active for high-sensitivity inversion behavior.
- Single-approver flow remains active for controlled tests.
- Constitution-level live inversion remains disabled.
- Code-change outputs are proposal-only and require explicit emit + sandbox verification.
- Test surfaces are opaque to LLMs via gateway policy and anti-probing lockouts.

## Why This Plan Exists

Inversion can alter how the system reasons, not just what it does. That makes it a high-impact mechanism.  
The rollout uses staged confidence growth: runtime safety probes, maturity checks, and stronger gates at deeper tiers.

## Phased Rollout

## Phase A (Beta, active now)

- Allow tactical + belief inversion in test/shadow with strict guardrails.
- Require objective IDs for belief+ tiers.
- Keep directive/constitution inversion blocked in live runtime.
- Use periodic maturity harness cycles with red-team + workflow nursery probes.
- Emit inversion proposals, first-principle extractions, and rejection reasons to audit logs.

Exit criteria:
- Sustained non-destructive harness performance.
- No critical safety regressions in runtime probes.
- Stable first-principle quality and anti-downgrade behavior.

## Phase B (Limited Live)

- Permit low-risk live apply only where shadow-pass gates are met.
- Enforce first-N human-veto windows by target tier.
- Maintain hard kill-switch on shadow critical-failure signals.
- Expand mirror-system simulation horizons (days -> weeks -> months by impact).

Exit criteria:
- Live apply outcomes remain non-destructive with rollback reliability.
- Tier transitions remain governance-compliant without drift escalation.

## Phase C (Mature Adaptive)

- Increase autonomy bands only after repeated controlled impossible-task passes.
- Keep identity/directive live access behind stricter, slower transition gates.
- Continue mandatory mirror simulation for high-impact proposals.

Exit criteria:
- Long-window stability under adversarial + chaos scenarios.
- Reproducible, auditable reasoning lineage for all deeper-tier actions.

## Phase D (Long-Horizon Research, not wired)

- Explore century-scale governance simulation for existential-class proposals.
- Evaluate federated oversight and multi-controller consensus before any deeper unlocks.
- Keep constitution-level live inversion disabled until separate governance charter is approved.

## Not Wired (Research Only)

## Dire-case auto-approval path

Research hypothesis only:
- Two-gate auto-approval in verified existential emergency conditions.
- Requires independent multi-signal confirmation and hard time-boxed rollback window.
- Remains disabled in beta/runtime code.

## Ghost-system visualization

Research visualization concept only:
- Display mirror/simulation runs as transparent "ghost systems" in the IDE.
- Distinct from live organs; never merged without explicit promotion.
- Not currently wired to holo-viz runtime.

## Enterprise Controls to Preserve

- Immutable never-invert axioms.
- Full shadow-pass kill switch before live apply at higher tiers.
- Anti-downgrade lock for first-principle confidence.
- Append-only audit ledger for all inversion attempts.
- Test opacity + anti-reverse-engineering lockout policy.

## Implementation Notes for Future Work

- Keep all deeper-tier changes reversible and separately versioned.
- Couple promotion decisions to measured runtime probes, not model assertions.
- Treat inversion as safety-critical infra: slower rollouts, tighter blast-radius controls.
