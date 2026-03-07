# UI Surface Maturity Matrix

## Purpose

Define what "enterprise-ready UI surface" means for this repo, and make coverage auditable.

This document is evidence-only: no claims without shipped artifacts.

## Scope

- CLI surfaces: `protheus`, `protheusd`, `protheusctl`, `protheus-top`
- Operator docs surfaces (runbooks, architecture, governance)
- Control plane interaction surfaces (status, verification, receipts)

## Maturity Levels

- `L0` ad-hoc: exists, undocumented, no ownership
- `L1` repeatable: documented setup and known command paths
- `L2` managed: test coverage + operator runbook + owner
- `L3` hardened: accessibility/UX contract + regression checks + incident path
- `L4` authoritative: metrics, release gates, and proof receipts for every major change

## Current Surface Inventory

| Surface | Owner | Current | Target | Required Evidence |
|---|---|---|---|---|
| CLI command family (`protheus*`) | Platform | L2 | L4 | command docs, test suite, release notes |
| Operator runbooks (`client/docs/OPERATOR_RUNBOOK.md`) | Ops | L2 | L4 | escalation path, drill receipts, dated review |
| Backlog and governance views | Governance | L3 | L4 | sync receipts, no manual edits, freshness checks |
| Security policy surfaces | Security | L2 | L4 | policy docs, template routing, review cadence |
| Contributor collaboration surface | DX | L1 | L3 | issue templates, triage contract, SLA evidence |

## UI Contract Requirements

- Every user-facing surface must have:
  - Named owner
  - Source file path
  - Last reviewed date
  - Failure mode and escalation path
- Any breaking UX change must include:
  - Before/after behavior summary
  - Validation steps
  - Changelog entry

## Update Cadence

- Weekly: check freshness of all surface docs.
- Release-time: confirm matrix rows still map to real artifacts.
- Quarterly: re-score maturity levels and adjust targets.

## Evidence Hooks

- Changelog entry references: `CHANGELOG.md`
- Backlog IDs: `SRS.md` (`UPGRADE_BACKLOG.md` compatibility alias)
- Generated backlog views: `client/docs/backlog_views/active.md`
