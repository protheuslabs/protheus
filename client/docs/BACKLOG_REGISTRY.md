# Backlog Registry

`client/systems/ops/backlog_registry.ts` (runtime: `client/systems/ops/backlog_registry.js`) provides a canonical machine-readable backlog source and generated markdown views.

## Commands

```bash
node client/systems/ops/backlog_registry.js sync
node client/systems/ops/backlog_registry.js check --strict=1
node client/systems/ops/backlog_registry.js status
```

## Policy

Policy file: `client/config/backlog_registry_policy.json`

Outputs:
- Canonical registry: `client/config/backlog_registry.json`
- Active view: `client/docs/backlog_views/active.md`
- Archive view: `client/docs/backlog_views/archive.md`
- Receipts: `state/ops/backlog_registry/latest.json`, `state/ops/backlog_registry/receipts.jsonl`

`check --strict=1` fails when generated artifacts drift from the canonical backlog markdown.

## Conduit Rebuild Chain

Conduit implementation/recovery is explicitly tracked as dependency-linked backlog items:

- `V6-CONDUIT-001` through `V6-CONDUIT-008`

These rows are the authoritative replay chain for rebuilding conduit requirements after regression.
