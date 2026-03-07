# Secret Broker Backend Migration and Rollback

## Scope

This guide covers the additive backend uplift for `client/lib/secret_broker`:

- `env` and `json_file` stay as stable defaults.
- New optional backends: `keychain` and `age_file`.
- Existing issue/resolve/rotation-check flows remain unchanged.

## Migration Path

1. Keep existing provider order and add new backends as disabled.
2. Configure `keychain` (`service`, `account`) and/or `age_file` (`paths`, `identity_paths`) under the target secret.
3. Enable exactly one new backend in staging.
4. Run:
   - `node client/systems/security/secret_broker.js rotation-check --strict=1`
   - `node client/systems/security/secret_broker.js issue --secret-id=<id> --scope=<scope>`
   - `node client/systems/security/secret_broker.js resolve --handle=<token> --reveal=1`
5. Confirm provider type in audit/health output and verify no consumer changes are required.
6. Promote to production by enabling the backend in policy.

## Rollback Path

1. Disable `keychain` / `age_file` provider(s) for the affected secret.
2. Re-enable previous fallback provider (`env` or `json_file`).
3. Re-run `rotation-check --strict=1` and a full issue/resolve cycle.
4. If needed, pin provider order so fallback is first while incident is active.

## Safety Notes

- Backend selection is fail-closed per provider and fail-open across provider chain.
- Keep fallback providers configured until backend reliability is proven.
- On Windows, `keychain` should use explicit command override until native command strategy is adopted.
