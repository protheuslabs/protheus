# Public Collaboration Triage Contract

## Objective

Define deterministic intake, prioritization, and response behavior for external collaboration.

## Intake Channels

- Bug report template (`.github/ISSUE_TEMPLATE/bug_report.md`)
- Feature request template (`.github/ISSUE_TEMPLATE/feature_request.md`)
- Security report routing (`SECURITY.md` and issue template notice)

## Label Taxonomy

- `type:bug`
- `type:feature`
- `type:security`
- `state:needs-repro`
- `state:needs-design`
- `state:blocked`
- `state:ready`
- `priority:p0` / `priority:p1` / `priority:p2` / `priority:p3`

## Triage SLA Targets

- Initial acknowledgment: within 2 business days
- First classification + labeling: within 5 business days
- Ready-for-work decision: within 10 business days

## Triage Workflow

1. Validate issue template completeness.
2. Reproduce (bugs) or scope (features).
3. Assign `type:*`, `priority:*`, and `state:*` labels.
4. Link to backlog item if accepted.
5. Close with explicit reason when declined or duplicate.

## Quality Bar

- No issue should remain unlabeled after triage window.
- Every closed issue must have a closure reason.
- Security-sensitive reports must avoid public disclosure details.

## Governance

- Weekly triage review: queue health, stale issues, SLA misses.
- Monthly calibration: adjust priorities and label definitions if recurring drift is detected.

