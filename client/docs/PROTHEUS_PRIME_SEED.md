# Protheus Prime Seed Bootstrap + Packaging

`client/systems/ops/protheus_prime_seed.js` is the conformance and packaging entrypoint for the Prime seed profile.

## Commands

```bash
# Show normalized profile contract
node client/systems/ops/protheus_prime_seed.js manifest

# Verify bootstrap conformance and provision minimal core files
node client/systems/ops/protheus_prime_seed.js bootstrap

# Build reproducible package metadata (strict fail-closed)
node client/systems/ops/protheus_prime_seed.js package --strict=1
```

Equivalent npm scripts:

```bash
npm run ops:prime-seed:manifest
npm run ops:prime-seed:bootstrap
npm run ops:prime-seed:package
```

## Fail-Closed Behavior

- Bootstrap returns non-zero if any `mandatory_paths` are missing.
- Bootstrap returns non-zero if any `mandatory_governance_paths` are missing.
- Package command fails in strict mode when bootstrap conformance is not green.

## Artifacts

- Bootstrap receipts: `state/ops/protheus_prime_seed/latest.json`
- Bootstrap history: `state/ops/protheus_prime_seed/history.jsonl`
- Package manifests: `state/ops/protheus_prime_seed/packages/<package_id>/package_manifest.json`
- Latest package pointer: `state/ops/protheus_prime_seed/packages/latest.json`
