# Documentation Program Governance

`V4-FORT-003` documentation hardening policy.

## Ownership Model

- each tier-1 doc has a named owner role
- owner accountability includes freshness and incident updates

## Review Cadence

- weekly freshness sweep for operational docs
- monthly governance review for policy docs
- release-time verification for user-facing docs

## Artifact Tiers

- tier-1: runbooks, security, governance contracts
- tier-2: architecture references and lane guides
- tier-3: exploratory and supplemental references

## ADR Usage Guidance

- changes to architecture or policy contracts require ADR entry/update
- canonical ADR assets live under `client/docs/adr/`

## Freshness Process

- stale docs open an explicit backlog follow-up item
- each update should link to backlog/release context

## Backlog + Release Linkage

- documentation updates link to backlog IDs in changelog/release notes
