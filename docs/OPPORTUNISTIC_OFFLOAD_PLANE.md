# Opportunistic Offload Plane

`RM-127` routes heavy tasks to attested nodes when local surface budget is constrained, with deterministic local fallback.

## Commands

```bash
node systems/hardware/opportunistic_offload_plane.js dispatch --job-id=example --complexity=0.8 --required-ram-gb=4 --required-cpu-threads=4
node systems/hardware/opportunistic_offload_plane.js status
```

## Routing Logic

- Local execution is preferred when:
  - `surface_budget_score >= local_execution_score_threshold`
  - `complexity <= local_max_complexity`
- Otherwise offload is attempted via attested schedule command.
- If offload scheduling fails, execution falls back to local with `fallback_reason`.

## Policy

Policy file: `config/opportunistic_offload_policy.json`

Key controls:
- Local/offload threshold knobs
- Embodiment snapshot source
- Schedule command (defaults to `attested_assimilation_plane schedule`)
- State/queue/receipt output paths
