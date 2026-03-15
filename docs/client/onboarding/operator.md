# Operator Onboarding Track

1. Run `./tests/tooling/scripts/onboarding/protheus_onboarding_bootstrap.sh --role=operator --dry-run=1`.
2. Validate status with `cargo run --manifest-path core/layer0/ops/Cargo.toml --bin protheus-ops -- health-status status --dashboard`.
3. Capture first verified change receipt in `state/ops/onboarding_portal/`.
