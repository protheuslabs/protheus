# Compliance Posture

## Purpose

`systems/ops/compliance_posture.js` provides a single operational score for deployment + controls readiness by aggregating:
- SOC2 evidence/readiness (`systems/ops/compliance_reports.js`)
- Integrity kernel state (`systems/security/integrity_kernel.js`)
- Startup attestation freshness (`systems/security/startup_attestation.js`)
- Deployment hardening gate (`systems/ops/deployment_packaging.js`)
- Contract surface stability (`systems/spine/contract_check.js`)

## Commands

Run (non-blocking posture snapshot):

```bash
node systems/ops/compliance_posture.js run --days=30 --profile=prod --strict=0
```

Run strict gate (non-zero unless verdict is `pass`):

```bash
node systems/ops/compliance_posture.js run --days=30 --profile=prod --strict=1
```

Status:

```bash
node systems/ops/compliance_posture.js status latest
```

## Output

Artifacts are written to:
- `state/ops/compliance_posture/YYYY-MM-DD.json`
- `state/ops/compliance_posture/latest.json`
- `state/ops/compliance_posture/history.jsonl`

## Scoring

Score is weighted via `config/compliance_posture_policy.json`.

Default thresholds:
- `pass`: score >= 0.80
- `warn`: score >= 0.65 and < 0.80
- `fail`: score < 0.65

This is a posture signal, not legal certification. Use it to drive operational remediation before external audits.
