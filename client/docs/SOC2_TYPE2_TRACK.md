# SOC2 Type II Track

`RM-133` compiles rolling 90+ day SOC2 evidence windows, tracks exceptions through closure, and emits auditor-ready attestation bundles.

## Commands

```bash
node client/systems/ops/soc2_type2_track.js run --days=90 --strict=1
node client/systems/ops/soc2_type2_track.js exception-open --id=exc_cc6 --control=cc6 --reason="control evidence gap"
node client/systems/ops/soc2_type2_track.js exception-close --id=exc_cc6 --resolution="evidence attached"
node client/systems/ops/soc2_type2_track.js bundle --window-id=latest
node client/systems/ops/soc2_type2_track.js status
```

## Policy

Policy file: `client/config/soc2_type2_policy.json`

Key gates:
- `minimum_window_days`
- `minimum_soc2_runs`
- `minimum_unique_evidence_days`
- `max_open_exception_days`
- `required_event_types`

## Artifacts

- `state/ops/soc2_type2_track/latest.json`
- `state/ops/soc2_type2_track/window_history.jsonl`
- `state/ops/soc2_type2_track/exceptions.json`
- `state/ops/soc2_type2_track/bundles/*.json`
- `state/ops/soc2_type2_track/receipts.jsonl`
