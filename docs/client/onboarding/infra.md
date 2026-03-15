# Infra Onboarding Track

1. Bootstrap using `./tests/tooling/scripts/onboarding/protheus_onboarding_bootstrap.sh --role=infra --dry-run=1`.
2. Run `protheus-ops benchmark-matrix run --refresh-runtime=1`.
3. Verify release-security workflow contract in `.github/workflows/release-security-artifacts.yml`.
