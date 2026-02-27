# Safety Resilience Guard

`systems/security/safety_resilience_guard.ts` dampens safety-system abuse patterns (alert floods / false-positive spirals) without disabling core containment.

## What it enforces

- Alert-burst and identical-reason anti-spam thresholds
- Consensus floor for `confirmed_malice` escalation
- Daily false-positive downgrade budget
- Graceful degradation to `stasis` when confidence is insufficient

## Integration

`systems/helix/helix_controller.ts` now routes Sentinel output through this guard before quarantine/hunter/reweave decisions.

## Policy

Policy file: `config/safety_resilience_policy.json`

Key controls:

- `anti_spam.window_minutes`
- `anti_spam.max_alerts_per_window`
- `anti_spam.max_identical_reason_burst`
- `consensus.min_independent_signals_for_confirmed_malice`
- `false_positive.max_daily_downgrades`

## Commands

```bash
node systems/security/safety_resilience_guard.js evaluate --sentinel-json='{"tier":"confirmed_malice"}' --signals-json='{"strand_mismatch":true}'
node systems/security/safety_resilience_guard.js status
```
