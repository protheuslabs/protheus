# Resurrection Protocol

`client/systems/continuity/resurrection_protocol.ts` provides catastrophic recovery ceremonies for rehydrating continuity-critical state onto a new host.

## Guarantees

- Multi-shard encrypted resurrection bundles
- Bundle verification with shard + envelope integrity checks
- Attested restore ceremony (`attestation-token`) per target host
- Rollback-safe restore path with pre-restore backups
- Immutable bundle/verify/restore receipts

## Policy

Policy file: `client/config/resurrection_protocol_policy.json`

State outputs:

- `state/continuity/resurrection/index.json`
- `state/continuity/resurrection/bundles/<bundle_id>/manifest.json`
- `state/continuity/resurrection/recovery/...`
- `state/continuity/resurrection/receipts.jsonl`

## Commands

```bash
# Create encrypted multi-shard bundle
node client/systems/continuity/resurrection_protocol.js bundle --bundle-id=seed_a --shards=3

# Verify bundle integrity + decryptability
node client/systems/continuity/resurrection_protocol.js verify --bundle-id=seed_a --strict=1

# Restore ceremony (apply=0 preview by default)
node client/systems/continuity/resurrection_protocol.js restore --bundle-id=seed_a --target-host=new_host --attestation-token=<token> --apply=1

# Inspect bundle index/status
node client/systems/continuity/resurrection_protocol.js status
```

`RESURRECTION_PROTOCOL_KEY` must be set for bundle/verify/restore.
