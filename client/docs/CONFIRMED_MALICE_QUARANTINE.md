# Confirmed Malice Quarantine (V3-033)

`client/systems/helix/confirmed_malice_quarantine.ts` implements the permanent quarantine lane for confirmed hostile copies.

## Purpose

- Differentiate routine drift (`clear`/`stasis`) from confirmed hostile branches.
- Enforce irreversible containment posture (unless explicit human-approved release).
- Persist forensic evidence receipts for post-incident investigation.

## Inputs

- Sentinel output (`tier`, `score`, `reason_codes`)
- Verifier mismatch counts
- Codex verification results
- Hunter action plan

## Gating Rules

- Requires `sentinel.tier=confirmed_malice` (configurable).
- Requires minimum independent signals (`min_independent_signals_for_permanent_quarantine`).
- Requires confidence floor (`min_confidence_for_permanent_quarantine`).
- Requires hunter isolation readiness when configured.

## Outputs

- State: `state/helix/permanent_quarantine_state.json`
- Latest: `state/helix/permanent_quarantine_latest.json`
- Events: `state/helix/permanent_quarantine_events.jsonl`
- Forensics: `state/helix/forensics/*.json`

## CLI

```bash
node client/systems/helix/confirmed_malice_quarantine.js status
node client/systems/helix/confirmed_malice_quarantine.js evaluate --input-json='{"sentinel":{"tier":"confirmed_malice","score":4}}' --apply=1
node client/systems/helix/confirmed_malice_quarantine.js release --human-approved=1
```

