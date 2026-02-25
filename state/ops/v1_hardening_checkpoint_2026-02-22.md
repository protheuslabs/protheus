# V1.0 Hardening Checkpoint (2026-02-22)

Generated: 2026-02-23T00:01:20.636Z
Window days: 14

## Score

- Weighted score: **0.889**
- Verdict: **PASS**
- Failed criteria: sensory_continuity

## Criteria

| Criterion | Pass | Weight | Detail |
|---|---:|---:|---|
| security_integrity | yes | 3 | integrity_kernel + architecture_guard |
| startup_attestation | yes | 2 | startup_attestation_verified |
| routing_health | yes | 2 | local_routing_healthy |
| sensory_continuity | no | 2 | dark_eyes + queue_backlog + proposal_starvation |
| drift_control | yes | 2 | spc_in_control |
| budget_governor | yes | 2 | budget_guard_clear |
| execute_readiness | yes | 2 | ready_for_execute |
| queue_hygiene | yes | 1 | open=21 stale_open=0 |
| outcome_throughput | yes | 2 | executed=12 shipped_rate=0.5 |

## Outcome Window

```json
{
  "window_days": 14,
  "attempted": 168,
  "executed": 12,
  "shipped": 6,
  "no_change": 6,
  "reverted": 0,
  "shipped_rate": 0.5
}
```

## Notes

- This checkpoint is for unattended-6-month V1 hardening readiness.
- `budget_governor` must stay clear in unattended mode.
- Re-run after major routing/security/autonomy policy changes.

## Next Steps

- Run queue hygiene + dark-eye remediation so proposal flow stays continuous.

