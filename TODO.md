# TODO

## Backlog Follow-Up (Layer Ownership Guard)

- [ ] `V6-ADAPT-CORE-001` Port adaptation primitives from temporary client bootstrap to core authority.
  - Layer target: `core/layer2` (authoritative runtime primitive for `REQ-19-001`, `REQ-19-002`, `REQ-19-003`).
  - Client role: Layer 3 conduit-only wrappers, operator CLI surface, and tests.
  - Completion criteria:
    - Rust core owns cadence/resource/continuity policy and receipts.
    - Client runtime adaptation code is compatibility-only (no policy authority).
    - All client↔core communication for adaptation flows only through conduit + scrambler.
  - Progress:
    - Core lane scaffold shipped: `protheus-ops adaptive-runtime <tick|status>` with deterministic receipts.
    - Client thin conduit shell shipped: `systems/adaptive/adaptive_runtime.{ts,js}`.

- [ ] `V6-CONDUIT-RUNTIME-STALL-001` Resolve local Rust binary startup stall impacting conduit-lane execution.
  - Layer target: `core/layer2/conduit` + `core/layer0/ops` runtime startup path.
  - Symptoms:
    - `conduit_stdio_timeout` on spine/status and mech benchmark preflight.
    - Rust binaries remain non-responsive in this environment until forcibly killed.
  - Progress:
    - Raised conduit stdio/bridge default timeout budgets (20s -> 120s+) across bridge callsites.
    - Added bridge-side child timeout/kill path in Rust conduit ops bridge to avoid indefinite child hangs.
    - Heartbeat and daemon spine calls now pass explicit timeout budgets for run/status lanes.
    - Added shared conduit runtime fault gate in `client/lib/spine_conduit_bridge.ts`:
      - records timeout-like failures,
      - activates backoff gate (`conduit_runtime_gate_active_until:*`),
      - fails fast on subsequent calls to stop death-loop timeouts.
    - Heartbeat/status surfaces now treat active gate as controlled degraded mode (`skipped_runtime_gate_active`) instead of hard failing every schedule tick.
    - `protheusd status` now exposes `conduit_runtime_gate` diagnostics and pauses cockpit watcher restart thrash with gate-aware backoff.
  - Completion criteria:
    - `conduit_daemon` responds to `start_agent` within timeout budget.
    - `ops:mech-suit:benchmark` completes without preflight host fault.
    - `formal:invariants:run` + conduit bridge smoke tests pass with live Rust lane.

- [x] `LOCAL-PARTITION-001` Migrate mutable runtime paths into unified local partitions.
  - Partition standard:
    - `client/local/` for user/device/instance client runtime artifacts.
    - `core/local/` for node-local core runtime artifacts.
  - Scope:
    - Migrate generated state/logs/secrets/private-lens/runtime adaptive outputs from legacy paths.
    - Keep source/test/docs artifacts in their canonical source directories.
  - Completion criteria:
    - Runtime writes default to `client/local/*` and `core/local/*`.
    - Legacy path reads remain as compatibility fallback during transition.
    - Reset command can wipe local partitions without touching source code.
  - Completed deliverables:
    - `protheusctl migrate-to-planes` (`plan|run|status`) shipped.
    - `client/tools/migrate_to_planes_runtime.sh` shipped for one-command migration bootstrap.
    - `local_runtime_partitioner` init/status/reset shipped + tested.
    - Benchmark/harness defaults moved to `client/local/state/*` for generated artifacts.

- [ ] `LOCAL-PARTITION-002` Finish remaining tracked runtime root migrations (`client/logs`, `client/secrets`) into `client/local/*`.
  - Layer target: `client/local` runtime partition + migration tooling in `client/systems/ops/migrate_to_planes.ts`.
  - Current gap:
    - `migrate_to_planes plan` still reports copy work for `client/logs` and `client/secrets`.
    - Legacy tracked root paths remain present instead of fully consolidated.
  - Completion criteria:
    - Run apply migration with checkpoint/rollback manifest.
    - Remove legacy tracked runtime copies from source root paths.
    - `ops:root-surface:check` and `ops:source-runtime:check` remain green.

- [ ] `V6-CI-HYGIENE-002` Restore strict CI pass for policy/contract gates after migration.
  - Layer target: `client/systems` policy contract surfaces + CI guard configuration.
  - Current gap:
    - `test:ci` fails on `js_holdout_audit_advisory` (unapproved unpaired JS inventory).
    - `contract_check` fails due missing expected tokens for `systems/sensory/eyes_intake.js`.
  - Completion criteria:
    - `npm run -s test:ci` exits `0`.
    - JS/TS holdout policy and contract tokens match declared architecture rules.
    - Any intentional exceptions are explicitly documented in policy registries.

- [ ] `V6-PARITY-003` Close current Protheus-vs-OpenClaw parity harness gap.
  - Layer target: cross-lane runtime health (`core` authority + `client` governance surfaces).
  - Current gap:
    - `ops:protheus-vs-openclaw` executes but returns exit `2` (`parity_pass: false`).
    - Failing scenarios include reliability and sustained autonomy dimensions.
  - Completion criteria:
    - `ops:protheus-vs-openclaw` exits `0` with `parity_pass: true`.
    - Weekly scorecard shows required pass ratio and weighted score thresholds.
    - Regression guard added so parity failures are surfaced before merge.

- [ ] `V6-MECH-LIVE-001` Remove mech benchmark host-timeout skip and require live ambient-lane execution.
  - Layer target: `core/layer2/conduit` + `core/layer0/ops` + mech benchmark contract in `client/systems/ops/mech_suit_benchmark.js`.
  - Current gap:
    - Benchmark now returns structured `host_runtime_timeout` skip instead of hard fail.
    - Ambient preflight still cannot validate live Rust spine path in this host runtime.
  - Completion criteria:
    - `ops:mech-suit:benchmark` runs full case set without `skip_reason`.
    - `ambient_mode_active` and summary booleans are sourced from live lane receipts.
    - Host-skip fallback stays disabled in CI/prod validation profiles.
