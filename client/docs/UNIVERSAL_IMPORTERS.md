# Universal Importers

`V4-MIGR-003` adds a pluggable importer surface at `client/systems/migration/importers/` and a CLI bridge for switching from other agent stacks.

## Supported Engines

- `openfang` (first-class importer)
- `crewai` (via generic JSON adapter)
- `autogen` (via generic JSON adapter)
- `langgraph` (workflow-graph adapter)
- `json`, `yaml`, `common_dump` generic adapters

## Command

```bash
# Direct lane
node client/systems/migration/universal_importers.js run --from=openfang --path=./dump/openfang.json --apply=1 --strict=1

# Control-plane façade
protheusctl import --from=openfang --path=./dump/openfang.json --apply=1 --strict=1
```

## Contract

- Parses source bundles from file or directory.
- Maps to canonical entity buckets (`agents`, `tasks`, `workflows`, `tools`, `records`).
- Emits deterministic summary report and optional mapped state artifact.
- Enforces no-loss transform checks in strict mode.

Receipts and reports are stored under `state/migration/importers/`.
