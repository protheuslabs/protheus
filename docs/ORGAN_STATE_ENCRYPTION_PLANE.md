# Organ State Encryption Plane

`V3-025` provides per-organ encryption for state, memory, and cryonics lanes with key-versioning, integrity MAC, rotation, and fail-closed decrypt denial.

## Commands

```bash
node systems/security/organ_state_encryption_plane.js encrypt --organ=workflow --lane=state --source=state/example.json
node systems/security/organ_state_encryption_plane.js decrypt --organ=workflow --cipher=state/example.json.enc.json --out=state/example.restored.json
node systems/security/organ_state_encryption_plane.js rotate-key --organ=workflow --reason="scheduled_rotation"
node systems/security/organ_state_encryption_plane.js verify --strict=1
node systems/security/organ_state_encryption_plane.js status
```

## Guarantees

- Per-organ keyring with active key version and historical versions for decrypt continuity.
- `aes-256-gcm` confidentiality plus explicit `hmac-sha256` envelope integrity MAC.
- Rotation receipts and decrypt receipts are append-only.
- Unauthorized decrypt attempts fail closed and emit system health alerts.
