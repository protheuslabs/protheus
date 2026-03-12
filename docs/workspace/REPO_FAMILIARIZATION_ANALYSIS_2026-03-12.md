# Repo Familiarization Analysis (2026-03-12)

## Scope

This analysis covered repository structure, architecture contracts, test surface, policy gates, size/cohesion hotspots, and execution posture for policy-first hardening.

## Architecture and Contract Surface

- Canonical architecture: Rust-first layered core (`core/layer_minus_one` -> `layer0` -> `layer1` -> `layer2` -> `layer3`) with thin client/cognition surfaces.
- Layer/source-of-truth documents reviewed:
  - `ARCHITECTURE.md`
  - `docs/SYSTEM-ARCHITECTURE-SPECS.md`
  - `docs/client/architecture/LAYER_RULEBOOK.md`
- Enforcement pipeline already contains boundary, formal spec, client layer, repo surface, public platform, and DoD gates via `verify.sh`.

## Repository Topology Snapshot

Tracked files by major root:

- `planes`: 1851
- `client`: 1633
- `tests`: 1035
- `docs`: 510
- `core`: 306
- `apps`: 117
- `scripts`: 75

Language/format line totals (tracked files):

- Rust: 135788 (`209` files)
- TypeScript: 27123 (`352` files)
- JavaScript: 21745 (`1108` files)
- Markdown: 60600 (`1153` files)
- JSON: 318932 (`2746` files)

Rust share (`.rs` vs `.ts`, tracked): `83.351%` (`rs=135788`, `ts=27123`).

## Hotspot Findings

Largest source files (risk to safe reviewability):

1. `core/layer2/execution/src/autoscale.rs` (`27817` lines)
2. `core/layer2/execution/src/inversion.rs` (`12309`)
3. `core/layer0/ops/src/model_router.rs` (`4344`)
4. `core/layer2/execution/src/decompose.rs` (`3258`)
5. `core/layer1/security/src/security_wave1.rs` (`3247`)

Threshold profile (code files in `core/client/adapters/apps/packages/scripts`):

- Files over cap (`600` core/default, `400` client thin): `63`
- Warning attention (`>800`): `45`
- Client files over thin cap (`400`): `9`

High churn concentration (recent history) is concentrated in:

- `package.json`
- `docs/workspace/SRS.md`
- `docs/workspace/TODO.md`
- `docs/workspace/UPGRADE_BACKLOG.md`
- Core ops authority lanes (model router, spine, main, strategy/governor paths)

This indicates both architectural authority and backlog/governance surfaces are central coupling points.

## Test and Verification Surface

- Workspace members (`Cargo`): 5 wildcard groups across layer roots (`layer_minus_one`, `layer0`, `layer1`, `layer2`, `layer3`).
- JS/TS test corpus under `tests/client-memory-tools`: 1022 test files.
- Rust unit test attributes detected: 931.
- Default verification path enforces policy gates before origin integrity (`./verify.sh`).

## Validation Run Results (This Turn)

Executed commands and outcomes:

1. `npm run -s test:ci:full` -> PASS.
2. `./verify.sh` -> PASS (including new module cohesion gate).
3. `node tests/client-memory-tools/ops_domain_conduit_runner_arg_passthrough.test.js` -> PASS.
4. `cargo test --workspace --all-targets --quiet` -> FAIL (pre-existing workspace breakages outside this change set):
   - missing include paths referenced by `core/layer2/execution/src/{autoscale.rs,inversion.rs}` for:
     - `client/runtime/systems/autonomy/autonomy_controller.ts`
     - `client/runtime/systems/autonomy/inversion_controller.ts`
     - `client/runtime/systems/autonomy/backlog_autoscale_rust_bridge.js`
   - unresolved crate import `tempfile` in layer2 autonomy tests.
5. `cargo test -p protheus-ops-core --quiet` -> FAIL on existing deterministic/hash test expectations unrelated to this policy tranche.

## Structural Risk Summary

1. Very large Rust authority files increase review and regression blast radius.
2. Client thin-surface intent exists, but a small set of client files still carry oversized adapter logic.
3. Existing CI policy stack is strong, but file cohesion/splitting policy was missing as an explicit enforceable gate.
4. Current SRS actionable map reports no runnable internal backlog (`execute_now=0`), with remaining items mostly external dependency blockers (`blocked_external_prepared=27`).

## Actions Executed This Turn

1. Added canonical module cohesion policy: `docs/client/MODULE_COHESION_POLICY.md`.
2. Added rulebook enforcement reference and verify contract wiring note in `docs/client/architecture/LAYER_RULEBOOK.md`.
3. Added contributor governance link in `docs/workspace/CONTRIBUTING.md`.
4. Added strict CI audit lane: `scripts/ci/module_cohesion_policy_audit.mjs`.
5. Added policy config + legacy debt baseline:
   - `client/runtime/config/module_cohesion_policy.json`
   - `client/runtime/config/module_cohesion_legacy_baseline.json`
6. Wired gate into runnable policy surfaces:
   - `package.json` (`ops:module-cohesion:audit`)
   - `verify.sh` (required gate)
7. Generated current audit artifacts:
   - `artifacts/module_cohesion_audit_current.json`
   - `docs/workspace/MODULE_COHESION_AUDIT_CURRENT.md`
8. Generated top-100 ROI execution ledger for this revision:
   - `docs/workspace/ROI_TOP100_EXECUTION_2026-03-12.md`
   - `artifacts/roi_top100_execution_2026-03-12.json`

## Current Module Cohesion Gate Result

From `ops:module-cohesion:audit --strict=1`:

- `pass=true`
- `scanned_files=661`
- `violations=0`
- `legacy_debt_count=63`
- `warning_attention_count=45`

This enforces no new oversize drift while keeping existing debt explicit and auditable.
