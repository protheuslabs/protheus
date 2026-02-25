# Personal Protheus Quickstart

## One-command install

```bash
node systems/ops/personal_protheus_installer.js install
```

This writes:
- `state/ops/personal_protheus/profile.json`
- `state/ops/personal_protheus/install_manifest.json`

## Verify

```bash
node systems/ops/personal_protheus_installer.js status
```

## Recommended startup

```bash
node systems/spine/spine.js daily
```

Start in `score_only` execution mode until readiness/guard checks are healthy.
