# Offsite DR Backup (RM-007)

Encrypted offsite backup and restore-drill flow now runs through `systems/ops/offsite_backup.js`.

## Policy

- Default policy path: `config/offsite_backup_policy.json`
- Override: `OFFSITE_BACKUP_POLICY_PATH=/abs/path.json`

## Key Environment Variables

- `STATE_BACKUP_OFFSITE_KEY` (required): encryption key material for AES-256-GCM.
  - Supported forms: plain text, `hex:<hex>`, `base64:<base64>`.
- `STATE_BACKUP_OFFSITE_DEST` (optional): offsite backup root.
- `STATE_BACKUP_DEST` (optional): local backup root used as sync source.

## CLI

```bash
node systems/ops/offsite_backup.js sync --strict=1
node systems/ops/offsite_backup.js restore-drill --strict=1
node systems/ops/offsite_backup.js status
node systems/ops/offsite_backup.js list --limit=10
```

## Receipts

- Sync receipts: `state/ops/offsite_backup_sync_receipts.jsonl`
- Restore drill receipts: `state/ops/offsite_restore_drill_receipts.jsonl`

Restore drill receipts include:

- `metrics.rto_minutes`
- `metrics.rpo_hours`
- gate outcomes (`verify_pass`, `rto_pass`, `rpo_pass`)

## Spine Integration

Daily spine can run sync + cadence-driven restore drills:

- `STATE_BACKUP_OFFSITE_ENABLED=1|0` (default `1`)
- `SPINE_OFFSITE_BACKUP_POLICY_PATH=config/offsite_backup_policy.json`
- `SPINE_OFFSITE_BACKUP_PROFILE=<profile>`
- `SPINE_OFFSITE_BACKUP_STRICT=1|0` (default `0`)
- `SPINE_OFFSITE_RESTORE_DRILL_ENABLED=1|0` (default `1`)
- `SPINE_OFFSITE_RESTORE_DRILL_STRICT=1|0` (default `0`)
- `SPINE_OFFSITE_RESTORE_DRILL_DEST=/abs/path` (optional override)

Ledger events:

- `spine_offsite_backup_sync`
- `spine_offsite_backup_sync_skipped`
- `spine_offsite_restore_drill_status`
- `spine_offsite_restore_drill`
- `spine_offsite_restore_drill_skipped`

