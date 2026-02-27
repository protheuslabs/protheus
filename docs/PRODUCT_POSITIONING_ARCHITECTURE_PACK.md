# Protheus Positioning and Architecture Pack

## 1. Positioning

Protheus is a governed autonomy runtime designed for high-trust execution:

- It is **not** an unconstrained autonomous agent.
- It is a **policy-first execution organism** with explicit safety, rollback, and attestation lanes.
- It prioritizes **deterministic governance** over novelty-only behavior.

Primary value proposition:

- Enterprise-grade actionability (receipted execution, rollback plans, audit trails)
- Long-horizon adaptive capability growth under strict guardrails
- Hardware-aware operation from constrained seed profiles to larger runtimes

## 2. Bounded Autonomy Model

Autonomy is bounded by layered gates:

1. `Constitution + identity + policy-root` constraints
2. `Risk/clearance/budget` route gating
3. `Nursery/adversarial/simulation` evidence before promotion
4. `Canary + rollback` for live mutation or high-risk actions
5. `Integrity/helix/attestation` trust checks on critical paths

No single lane can bypass all controls. High-risk paths require cumulative approval and runtime evidence.

## 3. Governance Constraints

Core invariants:

- Deny-by-default for sensitive effect classes
- Explicit reason codes for blocks/escalations
- Receipts for decisions and mutations
- Reversible execution for promoted changes
- Safe failure mode (quarantine/escalation before unsafe apply)

Governance is implemented as runtime policy, not informal convention.

## 4. Deployment Playbook

### Stage A: Local Seed

- Run with shadow-heavy policies
- Verify integrity and baseline health (`integrity`, `rm progress`, `runtime efficiency`)
- Keep high-risk lanes in approval mode

### Stage B: Controlled Live

- Enable canary execution and monitor closure SLOs
- Require receipt quality and rollback readiness
- Keep mutation and deep inversion behind explicit certification gates

### Stage C: Expanded Runtime

- Add hardware and adapters only through attested onboarding
- Maintain parity/efficiency/health SLOs
- Promote only after sustained non-regression windows

## 5. Evidence Links (Repository Artifacts)

- Governance/runbook:
  - `docs/OPERATOR_RUNBOOK.md`
  - `docs/BRANCH_PROTECTION_POLICY.md`
  - `docs/THREAT_MODEL_V1.md`
- Core policy surfaces:
  - `config/security_integrity_policy.json`
  - `config/workflow_executor_policy.json`
  - `config/inversion_policy.json`
  - `config/agent_passport_policy.json`
- Runtime audit state:
  - `state/security/`
  - `state/ops/`
  - `state/adaptive/workflows/executor/`

## 6. External Narrative (Short Form)

Protheus is a governed autonomous execution system for organizations that need:

- Reliability and traceability, not black-box automation
- Adaptive improvement without uncontrolled self-modification
- Practical deployment with measurable operating constraints

It is designed to be inspected, audited, and operated under explicit policy contracts.
