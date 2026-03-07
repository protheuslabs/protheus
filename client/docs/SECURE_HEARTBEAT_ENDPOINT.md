# Secure Heartbeat Endpoint

`SEC-M06` provides a hardened control-plane endpoint for signed heartbeat ingestion.

## Commands

```bash
node client/systems/security/secure_heartbeat_endpoint.js issue-key --client-id=primary
node client/systems/security/secure_heartbeat_endpoint.js receive --payload-json='{"heartbeat_id":"hb_1","ts":"2026-02-27T00:00:00.000Z"}' --key-id=<key_id> --ts=<unix_sec> --signature=<hex>
node client/systems/security/secure_heartbeat_endpoint.js verify --strict=1
node client/systems/security/secure_heartbeat_endpoint.js status
node client/systems/security/secure_heartbeat_endpoint.js serve --host=127.0.0.1 --port=8787
```

## Security Controls

- `key-id + HMAC-SHA256` signature verification
- timestamp skew gate (`auth.max_clock_skew_sec`)
- per-key rate limiting (`rate_limit.window_sec`, `rate_limit.max_requests_per_window`)
- append-only audit trail (`state/security/secure_heartbeat_endpoint/audit.jsonl`)
- alert feed for denied requests (`state/security/secure_heartbeat_endpoint/alerts.jsonl`)
- key lifecycle (`issue-key`, `revoke-key`, optional rotate-on-issue)

## Policy

See `client/config/secure_heartbeat_endpoint_policy.json`.
