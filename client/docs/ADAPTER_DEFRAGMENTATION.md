# Adapter Defragmentation + Profile Consolidation

`client/systems/actuation/adapter_defragmentation.js` analyzes adapter usage and profile coverage to identify bespoke adapters that should migrate to the universal primitive lane.

## Commands

```bash
# Generate daily snapshot
node client/systems/actuation/adapter_defragmentation.js run

# Read latest snapshot
node client/systems/actuation/adapter_defragmentation.js status latest
```

NPM shortcuts:

```bash
npm run actuation:defrag:run
npm run actuation:defrag:status
```

## Policy

Policy file: `client/config/adapter_defragmentation_policy.json`

Controls:

- `low_usage_threshold`
- `profile_ratio_target`
- `shared_module_hints`
- `exempt_adapters`

## Outputs

- Latest snapshot: `state/actuation/adapter_defragmentation/latest.json`
- History: `state/actuation/adapter_defragmentation/history.jsonl`

Snapshot includes:

- profile-vs-direct usage ratio
- module consolidation delta
- candidate adapters for migration to universal primitive
