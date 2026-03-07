# Onboarding Playbook

## Objective

Provide role-based onboarding that can scale to a larger engineering organization without losing safety, quality, or velocity.

## Shared Prerequisites

- Node and npm installed (version from repo lockfile/tooling)
- Local clone of repository
- Ability to run:
  - `npm ci`
  - `npm run build`
  - `npm run test`
- Read before first code change:
  - `README.md`
  - `CONTRIBUTING.md`
  - `client/docs/OPERATOR_RUNBOOK.md`
  - `client/docs/HISTORY_CLEANLINESS.md`
  - `client/docs/CLAIM_EVIDENCE_POLICY.md`

## Track A: Operator (Day 0 / Day 7 / Day 30)

### Day 0

- Start daemon and verify control plane:
  - `npm run start`
  - `protheus status`
- Read escalation surfaces in `client/docs/OPERATOR_RUNBOOK.md`.
- Confirm ability to run backlog sync:
  - `npm run ops:backlog:registry:sync`

### Day 7

- Execute one full dry-run of:
  - backlog update
  - docs update
  - validation check
  - changelog entry
- Submit one pull request with complete template fields.

### Day 30

- Lead one release-note pass.
- Perform one governance audit of generated backlog views and document outcome.

## Track B: Platform Engineer (Day 0 / Day 7 / Day 30)

### Day 0

- Run full local baseline:
  - `npm ci`
  - `npm run lint`
  - `npm run test`
- Identify one lane in `client/systems/` and map:
  - entrypoint
  - tests
  - dependent client/config/state files

### Day 7

- Ship one scoped change with:
  - tests
  - docs update
  - changelog entry
  - evidence links in PR

### Day 30

- Own one runbook/doc page with explicit review cadence.
- Participate in one incident rehearsal or recovery drill.

## Track C: External Contributor (Day 0 / Day 7 / Day 30)

### Day 0

- Read contribution and security policies.
- Use issue templates for bug/feature intake.
- Verify local build + tests pass before opening PR.

### Day 7

- Land one reviewed PR following commit hygiene and validation checklist.

### Day 30

- Participate in triage rotation (labels, prioritization, closure hygiene).

## Safety Gates

- Never bypass security disclosure workflow for vulnerabilities.
- Never hand-edit generated backlog registry/view artifacts.
- Never publish public metrics/claims without linked evidence.

## Success Criteria

- New engineer can produce a valid PR in < 1 day.
- Operator can execute and verify a backlog sync without assistance.
- No onboarding PR is merged without tests/client/docs/changelog coverage.

## Escalation Path

- Build/test failures: platform owner on current lane.
- Governance mismatch: backlog governance owner.
- Security concerns: follow `SECURITY.md` private reporting guidance.

