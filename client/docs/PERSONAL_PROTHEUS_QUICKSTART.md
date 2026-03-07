# Personal Protheus Quickstart

## One-command install

```bash
node client/systems/security/operator_terms_ack.js accept --operator-id=<id> --approval-note="initial_acceptance"
node client/systems/ops/personal_protheus_installer.js install
```

This writes:
- `state/ops/personal_protheus/profile.json`
- `state/ops/personal_protheus/install_manifest.json`

## Verify

```bash
node client/systems/ops/personal_protheus_installer.js status
```

## Recommended startup

```bash
node client/systems/spine/spine.js daily
```

Start in `score_only` execution mode until readiness/guard checks are healthy.

## Legal Terms

Before contributing or deploying commercially, review:

- `LICENSE`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `client/legal/archive/` (historical terms retained for audit context)
