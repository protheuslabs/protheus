# Supply Chain Trust Plane

`systems/security/supply_chain_trust_plane.ts` provides deterministic build trust artifacts and release-gate verification.

## Guarantees

- Deterministic artifact manifest (path + SHA256 + bytes)
- SBOM snapshot from `package-lock.json` / `package.json`
- Dependency pinning checks (`package-lock.json` required)
- Signed attestation over manifest + SBOM hashes
- Strict fail-closed merge-gate verification

## Policy

Policy file: `config/supply_chain_trust_policy.json`

Key controls:

- `artifact_roots`, `include_extensions`, `exclude_patterns`
- `require_lockfile`, `lockfile_path`, `package_json_path`
- `signature_key_env`, `allow_dev_fallback_key`
- output artifact paths (`manifest_path`, `sbom_path`, `attestation_path`, `latest_path`)

## Commands

```bash
# Generate/verify artifacts
node systems/security/supply_chain_trust_plane.js run --strict=1

# Verification-only lane used by merge guard
node systems/security/supply_chain_trust_plane.js run --strict=1 --verify-only=1

# Inspect latest status
node systems/security/supply_chain_trust_plane.js status
```

## Release gate

`systems/security/merge_guard.ts` now runs the supply-chain trust plane in strict verification mode.
