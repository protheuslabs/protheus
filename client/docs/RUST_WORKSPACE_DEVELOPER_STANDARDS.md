# Rust Workspace Developer Standards

## Required Conventions
- All crates declare MSRV and lint profile compatibility.
- Public interfaces require typed error enums and explicit docs.
- Unsafe blocks require justification comments and test coverage.

## Review Gates
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo test --workspace`
- governance receipt for performance-sensitive changes

## Ownership
- Assign codeowners per crate and require two-review approval for runtime-critical crates.
