# Backlog Registry

`systems/ops/backlog_registry.ts` (runtime: `systems/ops/backlog_registry.js`) provides a canonical machine-readable backlog source and generated markdown views.

## Commands

```bash
node systems/ops/backlog_registry.js sync
node systems/ops/backlog_registry.js check --strict=1
node systems/ops/backlog_registry.js status
```

## Policy

Policy file: `config/backlog_registry_policy.json`

Outputs:
- Canonical registry: `config/backlog_registry.json`
- Active view: `docs/backlog_views/active.md`
- Archive view: `docs/backlog_views/archive.md`
- Receipts: `state/ops/backlog_registry/latest.json`, `state/ops/backlog_registry/receipts.jsonl`

`check --strict=1` fails when generated artifacts drift from the canonical backlog markdown.
