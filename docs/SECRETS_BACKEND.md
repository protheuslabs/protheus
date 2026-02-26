# Secrets Backend Hardening (RM-006)

This system now supports policy-driven secret loading with rotation posture checks.

## Policy file

- Default path: `config/secret_broker_policy.json`
- Override path: `SECRET_BROKER_POLICY_PATH=/abs/path.json`

Each secret can define ordered providers:

- `env`
- `json_file`
- `command` (external backend bridge, e.g. Vault/Secrets Manager CLI)

## CLI

```bash
node systems/security/secret_broker.js issue --secret-id=<id> --scope=<scope>
node systems/security/secret_broker.js resolve --handle=<token> --scope=<scope>
node systems/security/secret_broker.js status
node systems/security/secret_broker.js rotation-check --strict=1
```

## Spine integration

Daily spine mode runs secret rotation checks by default.

Env flags:

- `SPINE_SECRET_ROTATION_CHECK_ENABLED=1|0` (default `1`)
- `SPINE_SECRET_ROTATION_CHECK_STRICT=1|0` (default `0`)
- `SPINE_SECRET_ROTATION_SECRET_IDS=id1,id2` (optional filter)
- `SPINE_SECRET_BROKER_POLICY_PATH=/abs/or/relative/path.json` (default `config/secret_broker_policy.json`)
- `SPINE_SECRET_ROTATION_CHECK_TIMEOUT_MS=45000` (bounded `5s..5m`)

Ledger events:

- `spine_secret_rotation_check`
- `spine_secret_rotation_check_skipped`

## Audit trail

Secret broker emits JSONL events to:

- `state/security/secret_broker_audit.jsonl`

Notable events include:

- `secret_handle_issued`
- `secret_handle_resolved`
- `secret_handle_issue_denied`
- `secret_handle_resolve_denied`
- `secret_value_loaded`
- `secret_value_load_failed`

