# Release Security Checklist

Use this checklist for every tagged release (starting at `v0.2.0`).

## Required

1. Tag release from a clean `main` commit.
2. Run merge/security gates:
   - `cargo run --quiet --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- enterprise-hardening run --strict=1`
   - `NODE_PATH=$PWD/node_modules npm run -s formal:invariants:run`
3. Generate per-artifact SBOM artifacts (CycloneDX JSON).
4. Generate detached signatures for each release artifact and verify signatures before upload.
5. Generate dependency-vulnerability SLA summary (`critical/high/medium`) and confirm gate budget.
6. Generate and validate release provenance bundle (`artifacts + hashes + rollback policy`).
7. Run strict supply-chain gate:
   - `cargo run --quiet --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- supply-chain-provenance-v2 run --strict=1 --policy=client/config/supply_chain_provenance_v2_policy.json`
8. Publish signed release notes with:
   - security-impact summary
   - migration notes
   - vulnerability/advisory references (if any)
9. Attach SBOM + checksums + signatures + provenance bundle + notes to the GitHub release.

## Optional But Recommended

- Run `protheus-ops benchmark-matrix run --refresh-runtime=1` and attach report snapshot.
- Include reproducibility notes (toolchain versions, commit hash, date).
