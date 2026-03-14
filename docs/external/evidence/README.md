# External Evidence Intake

Use this folder to unblock `blocked_external` SRS IDs.

## Layout

- One directory per ID: `docs/external/evidence/<ID>/`
- Required:
- `README.md` with decision/evidence summary and date
- At least one concrete artifact file (report, certificate, screenshot, export, attestation, or log)

## Validation

Run:

```bash
npm run -s ops:blocked-external:plan
npm run -s ops:blocked-external:evidence
```

Current status report is written to:

- `local/workspace/reports/BLOCKED_EXTERNAL_EVIDENCE_STATUS.md`
- `core/local/artifacts/blocked_external_evidence_status_current.json`

Do not place secrets in this tree without explicit approval and policy coverage.
