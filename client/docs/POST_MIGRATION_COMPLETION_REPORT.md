# Post-Migration Completion Report

`V4-MIGR-005` validates migration integrity and emits a deterministic completion report.

## What It Verifies

- Checkpoint and migration record presence.
- Required surface transfer (`config`, `memory`) and optional surfaces.
- Touched-file integrity against checkpoint.
- Transfer metrics and observed coverage ratio.
- Rollback state guard before finalization.

## Command

```bash
node client/systems/migration/post_migration_verification_report.js run \
  --migration-id=<id> \
  --strict=1 \
  --telemetry-consent=1 \
  --apply=1
```

- `--telemetry-consent=1` enables completion telemetry block in the report.
- `--apply=1` finalizes the migration status in the core migration registry when checks pass.

Reports and receipts are stored under `state/migration/post_migration_verification/`.
