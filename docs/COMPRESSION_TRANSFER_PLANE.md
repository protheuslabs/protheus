# Compression Transfer Plane

`RM-126` adds deterministic state compression/expansion for phone `<->` desktop/cluster profile movement.

## Commands

```bash
node systems/hardware/compression_transfer_plane.js compress
node systems/hardware/compression_transfer_plane.js expand --bundle-id=<id> --apply=1
node systems/hardware/compression_transfer_plane.js auto --target-profile=desktop --apply=1
node systems/hardware/compression_transfer_plane.js status
```

## Guarantees

- Bundle includes policy-scoped state files with SHA256 attestation digest
- Expand verifies attestation before any restore write
- Receipts are replayable (`state/hardware/compression_transfer_plane/receipts.jsonl`)
- Auto mode chooses `compress`/`expand` from profile rank (`phone < desktop < cluster`)

## Policy

Policy file: `config/compression_transfer_plane_policy.json`

Primary knobs:
- `include_paths` (state files to move into dormant bundle)
- `strict_default`, `apply_default`
- `bundle_dir`, `latest_path`, `receipts_path`
