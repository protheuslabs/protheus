# Deterministic Distributed Control Plane (`V3-046`)

`systems/distributed/deterministic_control_plane.js` provides a deterministic control-plane baseline for sovereign multi-node operation.

## Policy

- `config/deterministic_control_plane_policy.json`

Key controls:

- `quorum_size`
- `local_trust_domain`
- `leader_strategy`
- state/history paths

## Behavior

- Sovereign-by-default: only local trust-domain nodes participate in quorum/leader election.
- Foreign nodes are observed and receipted but never given authority.
- Partition-aware quorum:
  - active partition chosen deterministically (highest eligible count, lexical tie-break).
  - leader election deterministic inside active partition.
- Failover receipts emitted when leader changes.

## Commands

```bash
node systems/distributed/deterministic_control_plane.js run --nodes-json='[...]' --apply=1
node systems/distributed/deterministic_control_plane.js status
```

## Outputs

- Latest snapshot: `state/distributed/control_plane/latest.json`
- History: `state/distributed/control_plane/history.jsonl`
