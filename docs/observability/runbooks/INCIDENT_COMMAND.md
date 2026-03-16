# Incident Command Runbook

## Trigger
- PagerDuty `sev0` or `sev1` page.
- Manual declaration by incident commander.

## Roles
- Incident Commander: owns timeline and severity decisions.
- Operations Lead: executes mitigation and rollback.
- Communications Lead: posts stakeholder updates.

## First 5 Minutes
1. Declare severity and assign roles.
2. Freeze deploys and capture blast radius.
3. Start UTC timeline and evidence log.

## Exit Criteria
- Service stabilized with monitors green.
- MTTA and MTTR recorded.
- Postmortem opened with owners and due dates.

