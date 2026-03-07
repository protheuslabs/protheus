# IP Posture Review

This document defines the SEC-M05 strategy baseline.

## Objectives

- Preserve trade-secret controls for novel runtime/security/governance lanes.
- Track provisional-patent candidates with evidence lineage.
- Maintain counsel review records and filing decisions.

## Scope

- Runtime architecture and control-plane mechanisms.
- Security/anti-cloning and governance controls.
- Economic/symbiosis primitives that represent novel system behavior.

## Evidence Lanes

- `state/security/ip_posture_review/invention_register.json`
- `state/security/ip_posture_review/counsel_records.json`
- `state/security/ip_posture_review/evidence_pack.json`
- `state/security/ip_posture_review/receipts.jsonl`

## Commands

```bash
node client/systems/security/ip_posture_review.js draft --apply=1
node client/systems/security/ip_posture_review.js evidence-pack --apply=1
node client/systems/security/ip_posture_review.js record-counsel --counsel="outside_counsel" --decision=approve --approval-note="initial review" --apply=1
node client/systems/security/ip_posture_review.js status --strict=1
```

## Retention

- Counsel records: retain indefinitely (immutable timeline).
- Evidence pack snapshots: retain each major release and each filing decision.
- Invention register: append-only updates with rationale and owner.

