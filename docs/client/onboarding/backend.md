# Backend Onboarding Track

1. Bootstrap using `./scripts/onboarding/protheus_onboarding_bootstrap.sh --role=backend --dry-run=1`.
2. Run `cargo test -p protheus-ops-core` and `cargo clippy -p protheus-ops-core --all-targets -- -D warnings`.
3. Commit one deterministic lane receipt update.
