# Secret Rotation + Manager Migration Runbook (SEC-M03)

This runbook governs secret rotation posture, migration off repo-local secret files, and evidence attestation.

## 1) Validate broker + migration posture

```bash
node client/systems/security/secret_broker.js status
node client/systems/security/secret_broker.js rotation-check --strict=1
node client/systems/security/secret_rotation_migration_auditor.js scan
node client/systems/security/secret_rotation_migration_auditor.js status --strict=1
```

## 2) Rotate active secrets

- Rotate provider-side credentials for each active secret id in `client/config/secret_broker_policy.json`.
- Update secrets only through approved secret-manager lanes (`env`, external secrets dir, or command backend).
- Do not place plaintext tokens in tracked repository paths.

## 3) Attest completion

After rotation + history scrub verification:

```bash
node client/systems/security/secret_rotation_migration_auditor.js attest \
  --operator-id=$USER \
  --approval-note="sec-m03 rotation completed and history verified" \
  --apply=1
```

This writes:

- `client/config/secret_rotation_attestation.json`
- `state/security/secret_rotation_migration/receipts.jsonl`

## 4) Quarterly refresh

- Re-run the same flow at least every 90 days.
- If strict status fails, block merge until remediation is complete.
