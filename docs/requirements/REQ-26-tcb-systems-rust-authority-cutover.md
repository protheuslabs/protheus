# REQ-26 — TCB Systems Rust Authority Cutover

Status: in_progress  
Owner: Protheus Core  
Updated: 2026-03-06

## Objective

Enforce Rust as the runtime source of truth for TCB system domains while preserving TS as thin surface code only.

TCB targets:

- `systems/security/`
- `systems/ops/`
- `systems/memory/`
- `systems/sensory/`
- `systems/autonomy/`
- `systems/assimilation/`

TS surface-only allowlist:

- `systems/ui/`
- `systems/marketplace/`
- `systems/extensions/`

## Acceptance Criteria

1. Core entrypoint launchers in the TCB paths dispatch to Rust binaries/crates.
2. Rust `protheus-ops` exposes native domains for any newly cutover controllers.
3. Policy gates encode TCB-required prefixes and TS surface allowlist.
4. `cargo test -p protheus-ops-core` and `cargo clippy -p protheus-ops-core --all-targets -- -D warnings` pass.
5. `formal:invariants:run` remains green.

## Phase-1 Deliverables (this batch)

- Restored Rust runtime dispatch shims for reverted launchers:
  - `systems/ops/protheusctl.js`
  - `systems/ops/state_kernel.js`
  - `systems/ops/autotest_controller.js`
  - `systems/ops/autotest_doctor.js`
  - `systems/autonomy/autonomy_controller.js`
  - `systems/autonomy/health_status.js`
  - `systems/autonomy/inversion_controller.js`
  - `systems/autonomy/strategy_mode_governor.js`
  - `systems/memory/idle_dream_cycle.js`
  - `systems/memory/rust_memory_transition_lane.js`
  - `systems/memory/memory_recall.js` (mapped to `memory-cli` command semantics)
- Added Rust-native domains:
  - `assimilation-controller` (`crates/ops/src/assimilation_controller.rs`)
  - `sensory-eyes-intake` (`crates/ops/src/sensory_eyes_intake.rs`)
- Switched launcher entrypoints:
  - `systems/assimilation/assimilation_controller.js`
  - `systems/sensory/eyes_intake.js`
- Added shared bridge helper:
  - `lib/rust_lane_bridge.js`
- Updated governance policy:
  - `config/rust_source_of_truth_policy.json`
  - `codex_enforcer.md`

## Remaining Work

1. Port remaining non-wrapper TS logic in `security/sensory/assimilation/memory/autonomy` to Rust modules with behavior parity tests.
2. Retire legacy TS control-flow implementations after parity gates are green.
3. Extend policy/audit tooling to fail CI when new non-surface TS control logic appears under TCB prefixes.

## Phase-2 Deliverables (top-8 ops/security lanes)

- Added Rust domains in `crates/ops`:
  - `execution_yield_recovery`
  - `protheus_control_plane`
  - `rust50_migration_program`
  - `venom_containment_layer`
  - `dynamic_burn_budget_oracle`
  - `backlog_registry`
  - `rust_enterprise_productivity_program`
  - `backlog_github_sync`
- Updated both TS and JS lane entrypoints for these domains to thin wrappers through `lib/rust_lane_bridge.js`.
- Added CLI domains in `crates/ops/src/main.rs` and module exports in `crates/ops/src/lib.rs`.
