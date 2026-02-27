# Helix Baseline and Reweave

V2-HLX-001 and V2-HLX-003 are implemented through `systems/helix/helix_controller.ts` and `systems/helix/reweave_doctor.ts`.

## Baseline

```bash
node systems/helix/helix_controller.js init
node systems/helix/helix_controller.js baseline
```

Baseline status verifies:

- codex root availability + verification
- manifest presence/strand count
- reweave snapshot availability
- shadow-mode baseline (`config/helix_policy.json`)

## Reweave

```bash
node systems/helix/helix_controller.js reweave --reason="manual_recovery" --apply=0
node systems/helix/helix_controller.js reweave --reason="manual_recovery" --apply=1 --approval-note="incident_approved"
```

- `--apply=0`: plan only.
- `--apply=1`: policy-gated restore using snapshot-backed content recovery.
- if `shadow_only=true`, apply requests are blocked (`reason=shadow_only_mode`).
