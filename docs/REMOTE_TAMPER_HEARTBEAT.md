# Remote Tamper Heartbeat

`V3-026` adds a signed heartbeat lane that attests runtime identity and integrity posture, then automatically moves to quarantine when anomalies are detected.

## Commands

```bash
node systems/security/remote_tamper_heartbeat.js emit
node systems/security/remote_tamper_heartbeat.js verify --strict=1
node systems/security/remote_tamper_heartbeat.js status
node systems/security/remote_tamper_heartbeat.js clear-quarantine --reason="manual_review_complete"
```

## Coverage

- Signed heartbeat contains: build ID, watermark, constitution hash, integrity probe result.
- Trusted identity baseline is pinned and mismatches are classified as anomalies.
- Anomalies auto-activate quarantine mode with evidence bundle + notification receipts.
- Verification path checks signature validity, staleness window, and quarantine state coherence.
