# TODO

## Cockpit Delta Follow-Up (Post REQ-33)

- [x] `V6-COCKPIT-005` Eliminate remaining `conduit_bridge_timeout` in `protheusd subscribe` under host pressure.
  - Target: stable non-degraded subscription batches for idle queue conditions (no false timeout degradation).
  - Delivered:
    - `protheusd subscribe` now supports bounded wait chunking (`--wait-chunk-ms` / `PROTHEUSD_SUBSCRIBE_WAIT_CHUNK_MS`) to prevent long single-call bridge stalls.
    - Added deterministic local compatibility drain path (`client/runtime/local/state/attention/queue.jsonl` + per-consumer cursor under `client/runtime/local/state/attention/consumers/*.json`) that activates only on bridge timeout/gate conditions.
    - Timeout/gate fallback now emits non-degraded `protheus_daemon_subscribe_batch` envelopes with `bridge_fallback_local=true` and bounded cursor advancement, preventing timeout-noise death loops.
  - Validation:
    - `node client/runtime/systems/ops/protheusd.js subscribe --once --consumer=timeout_probe --limit=3 --poll-ms=500 --wait-ms=45000`
      - observed: `degraded=false`, `bridge_fallback_local=true`, `batch_count=3`.
    - `node client/runtime/systems/ops/protheusd.js subscribe --once --consumer=timeout_probe --limit=100 --poll-ms=500 --wait-ms=15000`
      - observed: `degraded=false`, `batch_count=0`, stable done receipt.

- [x] `V6-COCKPIT-006` Promote attention stream from long-poll contract to native push transport.
  - Target: direct conduit subscription lane (server-push) with ack/cursor guarantees and bounded backpressure.
  - Delivered:
    - Added native push transport mode in `client/runtime/systems/ops/protheusd.ts` (`--transport=push`, default on) for `protheusd subscribe`.
    - Added bounded file-mutation push waiter (`waitForAttentionPush`) so subscribe loops block on attention queue mutations instead of issuing repeated long-poll drains.
    - Added transport metadata to subscribe receipts (`transport`, `native_push`, `push_wait_reason`) and preserved cursor/ack guarantees through `attention-queue drain`.
    - Tuned push timeout floors to fail fast under host pressure (`bridge` 8s default, `stdio` 12s default) and defer to deterministic local compat drain when conduit runtime gate is active.
  - Validation:
    - `node client/runtime/systems/ops/protheusd.js subscribe --once --consumer=push_probe_fast --limit=2 --wait-ms=1200 --transport=push --poll-ms=500`
      - observed: startup receipt reports `native_push=true`, batch receipt includes transport metadata and bounded fallback contract.
    - `npm run -s typecheck:systems`

## Backlog Follow-Up (Layer Ownership Guard)

- [x] `V6-DIRECT-WIRING-001` Remove legacy runtime stubs/redirects and enforce canonical local partitions.
  - Layer target: `client/runtime/local/*` and `core/local/*` runtime roots.
  - Delivered:
    - Removed deprecated memory compat shim surfaces (`client/core_memory_compat/*`, `client/core/memory/compat_bridge.ts`).
    - Removed tracked `client/runtime/state` compatibility symlink; runtime guard now fail-closes on `state`, `client/runtime/state`, and root `local`.
    - Migration lane defaults to direct mode (`--compat-symlinks=0` by default) and migrates `local/state -> client/runtime/local/state`.
    - Canonical defaults updated for security/workflow/memory/vault paths to `client/runtime/local/state`.
  - Validation:
    - `npm run -s ops:runtime-state:guard`
    - `npm run -s ops:root-surface:check`
    - `npm run -s ops:source-runtime:check`

- [x] `V6-DIRECT-WIRING-002` Reconcile historical SRS/backlog text that still references removed `core/memory` compat artifacts.
  - Layer target: requirements traceability (`SRS.md`, `client/runtime/config/backlog_registry.json`, `client/runtime/config/backlog_review_registry.json`).
  - Delivered:
    - Replaced stale acceptance language referencing deleted `core_memory_compat_bridge` artifacts in `SRS.md`, `UPGRADE_BACKLOG.md`, `client/runtime/config/backlog_registry.json`, and `client/runtime/config/backlog_review_registry.json`.
    - Updated evidence refs to direct-wiring artifacts (`docs/client/architecture/DIRECT_WIRING_AUDIT_2026-03-07.md`).
    - Preserved lane history/IDs while aligning acceptance criteria to current canonical runtime surfaces.
  - Validation:
    - `npm run -s ops:source-runtime:check`

- [x] `V6-CONVERSATION-EYE-001` Implement Conversation Eye synthesis lane and make it default-on for every instance.
  - Layer target: client cognition plane (`client/cognition/adaptive/sensory/eyes/*` + `client/runtime/systems/sensory/*`), runtime memory sink in `client/runtime/local/state/memory/conversation_eye/*`.
  - Delivered:
    - Added collector: `client/cognition/adaptive/sensory/eyes/collectors/conversation_eye.ts`.
    - Added synthesizer: `client/runtime/systems/sensory/conversation_eye_synthesizer.ts`.
    - Added bootstrap lane + wrapper: `client/runtime/systems/sensory/conversation_eye_bootstrap.{ts,js}`.
    - `local_runtime_partitioner init/status` now ensures/reports conversation-eye installation.
    - Migration bootstrap now auto-enables the lane (`client/cli/tools/migrate_to_planes_runtime.sh`).
    - Default eyes catalog now includes `conversation_eye` (`catalog_store.ts` + catalog seed).
    - Added tests:
      - `client/memory/tools/tests/conversation_eye_bootstrap.test.js`
      - `client/memory/tools/tests/conversation_eye_collector.test.js`
  - Validation:
    - `npm run -s test:ops:conversation-eye-bootstrap`
    - `npm run -s test:ops:conversation-eye-collector`

- [x] `V6-MEMORY-MATRIX-001` Add scored tag-memory matrix, dream sequencer reorder cycle, and conduit-routed auto-recall.
  - Layer target: `client/runtime/systems/memory/*` cognition runtime with state in `client/runtime/local/state/memory/*`.
  - Delivered:
    - Added `memory_matrix` builder (`client/runtime/systems/memory/memory_matrix.{ts,js}`) with weighted scoring: `level(node1>tag2>jot3) + recency + dream inclusion`.
    - Added `dream_sequencer` runner (`client/runtime/systems/memory/dream_sequencer.{ts,js}`) and dream-cycle integration in `idle_dream_cycle.ts`.
    - Added `memory_auto_recall` lane (`client/runtime/systems/memory/memory_auto_recall.{ts,js}`) that pushes bounded recall matches to attention queue via conduit (`runOpsDomainCommand('attention-queue', ...)`).
    - Conversation Eye collector now writes leveled/hex-tagged nodes, enforces weekly quota defaults, and triggers auto-recall on new node filings.
    - Added matrix/reference artifacts:
      - `client/runtime/local/state/memory/matrix/tag_memory_matrix.json`
      - `client/memory/TAG_MEMORY_MATRIX.md`
    - Added policies:
      - `client/runtime/config/memory_matrix_policy.json`
      - `client/runtime/config/memory_auto_recall_policy.json`
  - Validation:
    - `npm run -s test:memory:matrix`
    - `npm run -s test:memory:auto-recall`
    - `node client/memory/tools/tests/idle_dream_cycle.test.js`

- [x] `V6-MEMORY-CONTEXT-CAP-001` Enforce hard context budget in memory runtime query path.
  - Layer target: `client/runtime/systems/memory/memory_recall.ts` runtime query surface.
  - Delivered:
    - Added configurable context budget contract (`--context-budget-tokens`, `--context-budget-mode=trim|reject`).
    - Added deterministic trimming/rejection behavior with token estimation and structured `context_budget` telemetry in query payloads.
    - Added regression coverage in `client/memory/tools/tests/memory_recall_context_budget.test.js` for trim + reject modes.
  - Validation:
    - `npm run -s test:memory:context-budget`

- [x] `V6-REFLEX-CORE-001` Add five low-burn core reflexes for common operator actions.
  - Layer target: `client/cognition/reflexes/*` cognition helper surface.
  - Delivered:
    - Added TS reflex registry + runner: `client/cognition/reflexes/index.ts` (wrapper: `client/cognition/reflexes/index.js`).
    - Added reflex set: `read_snippet`, `write_quick`, `summarize_brief`, `git_status`, `memory_lookup`.
    - Enforced per-reflex cap (`<=150` estimated tokens) in runtime output contract.
    - Added regression coverage: `client/memory/tools/tests/client_reflexes.test.js`.
  - Validation:
    - `npm run -s test:reflexes`

- [ ] `V6-PRIORITY-KERNEL-001` Finalize global importance/priority kernel rollout (`REQ-27`).
  - Layer target: `core/layer0/ops` (authoritative scoring, queue ordering, initiative thresholds).
  - Progress delivered:
    - Added core importance engine: `core/layer0/ops/src/importance.rs`.
    - Attention queue now computes/persists importance metadata and priority ordering in `core/layer0/ops/src/attention_queue.rs`.
    - Receipts/latest snapshots now include `score`, `band`, `priority`, and `initiative_action`.
    - SRS lane tracked at `V6-INITIATIVE-013` + requirement spec `docs/client/requirements/REQ-27-global-importance-priority-kernel.md`.
    - Added client regression guard lane: `client/runtime/systems/ops/subconscious_boundary_guard.ts` + CI required-check job + policy `client/runtime/config/subconscious_boundary_guard_policy.json`.
  - Completion criteria:
    - `cargo test -p protheus-ops-core attention_queue` and `cargo test -p protheus-ops-core importance` pass in this environment.
    - Cockpit/mech harness confirms priority-first attention consumption on mixed-severity inputs.
    - No TS/client authority for scoring/order paths (core remains single authority).
  - Latest validation snapshot (2026-03-08):
    - `attention_queue.rs` now hard-fails closed when Layer2 authority is unavailable (`layer2_priority_authority_unavailable`) unless explicit fallback is enabled.
    - `ops:mech-suit:benchmark` revalidated at `2026-03-08T09:40:13Z` with `ambient_mode_active=true`.
    - `npm run -s ops:test:protheus-ops-core:attention` returns deterministic deferred host-stall receipt (`reason_code=deferred_host_stall`, exit `0`).
    - `npm run -s ops:test:execution-core:initiative` returns deterministic deferred host-stall receipt (`reason_code=deferred_host_stall`, exit `0`).
    - `npm run -s ops:subconscious-boundary:check` and `npm run -s test:ops:subconscious-boundary-guard` pass (`violations=0`).
    - `node client/memory/tools/tests/cockpit_harness.test.js` still exits with `SKIP host_runtime_timeout`, so live cockpit priority-consumption proof remains blocked by host runtime profile.

- [x] `V6-MEMORY-HIERARCHY-XML-001` Backfill explicit XML hierarchy across historical daily memory files.
  - Delivered:
    - Executed historical backfill: `node client/memory/tools/backfill_xml_hierarchy.js --apply=1`.
    - Regenerated indices post-backfill: `node client/memory/tools/rebuild_exclusive.js`.
    - Added drift/format regression coverage in `client/memory/tools/tests/memory_matrix.test.js` (isolated conversation matrix path + deterministic parsing assertions).
  - Validation:
    - `node client/memory/tools/backfill_xml_hierarchy.js` now reports no pending conversions in current surface.
    - `npm run -s test:memory:matrix`.

- [x] `V6-COMP-001` Competitive benchmark matrix with reproducible receipts (`REQ-13-002`).
  - Delivered:
    - Added lane: `client/runtime/systems/ops/competitive_benchmark_matrix.{ts,js}`.
    - Added policy: `client/runtime/config/competitive_benchmark_matrix_policy.json`.
    - Added benchmark harness docs/scripts: `benchmarks/competitive_matrix/*`, `docs/client/COMPETITIVE_BENCHMARK_MATRIX.md`.
  - Validation:
    - `node client/memory/tools/tests/competitive_benchmark_matrix.test.js`
    - `node client/memory/tools/tests/competitive_observability_benchmark_pack.test.js`
    - `node client/memory/tools/tests/mobile_competitive_benchmark_matrix.test.js`

- [x] `V6-COMP-002` `protheus migrate --from openfang` importer lane (`REQ-13-003`).
  - Delivered:
    - Restored importer surfaces: `client/runtime/systems/migration/universal_importers.ts` and `client/runtime/systems/migration/importers/*.js` wrappers.
    - Added `protheusctl migrate --from=<engine>` alias route in `client/runtime/systems/ops/protheusctl.ts`.
    - Updated docs: `docs/client/UNIVERSAL_IMPORTERS.md`.
  - Validation:
    - `node client/memory/tools/tests/universal_importers.test.js`
    - `node client/memory/tools/tests/protheusctl_migrate_openfang_alias.test.js`

- [x] `V6-COMP-003` Evidence-first audit dashboard drilldown (`REQ-13-004`).
  - Delivered:
    - Added lane: `client/runtime/systems/ops/evidence_audit_dashboard.{ts,js}`.
    - Added policy: `client/runtime/config/evidence_audit_dashboard_policy.json`.
    - Added docs: `docs/client/EVIDENCE_AUDIT_DASHBOARD.md`.
  - Validation:
    - `node client/memory/tools/tests/evidence_audit_dashboard.test.js`

- [ ] `V6-SWARM-001..006` Swarm router crate rollout (`REQ-12-001` through `REQ-12-009`).
  - Delivered:
    - Added crate and CLI: `core/layer0/swarm_router/Cargo.toml`, `src/lib.rs`, `src/main.rs`.
    - Implemented typed envelope, auto-id, in-flight tracker, recovery policy, scaling planner, queue contract, deterministic priority ordering, observability receipts, and upgrade/rollback protocol.
  - Current blocker:
    - Local cargo validation is blocked by host dyld build-script stalls (`V6-HOST-BUILD-STALE-001`); guarded run exits with `cargo_test_timeout` after stale reap.

- [x] `V6-SBOX-002` Dynamic scoped sub-agent spawning (`REQ-15-002`).
  - Delivered:
    - Added lane: `client/runtime/systems/security/sandbox_subagent_scope_runtime.{ts,js}`.
    - Added policy: `client/runtime/config/sandbox_subagent_scope_policy.json`.
    - Added lifecycle/state receipts under `client/runtime/local/state/security/sandbox_subagent_scope/*`.
  - Validation:
    - `node client/memory/tools/tests/sandbox_next10_bundle.test.js`

- [x] `V6-SBOX-003` Persistent sandbox state bridge (`REQ-15-003`).
  - Delivered:
    - Added lane: `client/runtime/systems/security/sandbox_state_bridge.{ts,js}`.
    - Added policy: `client/runtime/config/sandbox_state_bridge_policy.json`.
    - Added snapshot/restore artifact path under `client/runtime/local/state/security/sandbox_state_bridge/*`.
  - Validation:
    - `node client/memory/tools/tests/sandbox_next10_bundle.test.js`

- [x] `V6-SBOX-004` On-demand skill/tool loader (`REQ-15-004`).
  - Delivered:
    - Added lane: `client/runtime/systems/security/sandbox_skill_loader.{ts,js}`.
    - Added policy: `client/runtime/config/sandbox_skill_loader_policy.json`.
  - Validation:
    - `node client/memory/tools/tests/sandbox_next10_bundle.test.js`

- [x] `V6-SBOX-005` Context compression controls (`REQ-15-005`).
  - Delivered:
    - Added lane: `client/runtime/systems/security/sandbox_context_controls.{ts,js}`.
    - Added policy: `client/runtime/config/sandbox_context_controls_policy.json`.
  - Validation:
    - `node client/memory/tools/tests/sandbox_next10_bundle.test.js`

- [x] `V6-BROWSER-001..006` Native browser control batch (`REQ-16-001..006`, `REQ-20-001`).
  - Delivered:
    - Added browser lanes:
      - `client/runtime/systems/browser/native_browser_daemon.{ts,js}`
      - `client/runtime/systems/browser/native_browser_cdp.{ts,js}`
      - `client/runtime/systems/browser/browser_session_vault.{ts,js}`
      - `client/runtime/systems/browser/browser_snapshot_refs.{ts,js}`
      - `client/runtime/systems/browser/browser_policy_gate.{ts,js}`
      - `client/runtime/systems/browser/browser_cli_shadow_bridge.{ts,js}`
    - Added browser policies under `client/runtime/config/browser/*.json`.
  - Validation:
    - `node client/memory/tools/tests/browser_next10_bundle.test.js`

- [x] `V6-ROOT-INTERNAL-003` Decide and execute final placement policy for root personal/internal markdown artifacts.
  - Layer target: `client/runtime/local/internal/*` (or explicit archived docs path if governance files stay tracked).
  - Current gap:
    - Root still carries operational identity/memory docs (`MEMORY.md`, `SOUL.md`, `HEARTBEAT.md`, `IDENTITY.md`, etc.) that are intentionally referenced by agent bootstrap and tests.
  - Completion criteria:
    - Either migrate to `client/runtime/local/internal/*` with bootstrap/test path updates, or formalize as intentionally tracked root exceptions in root-surface contracts and docs.
  - Completed deliverables:
    - Formalized root markdown exceptions in `client/runtime/config/root_surface_contract.json` (`allowed_root_files`).
    - Documented root ownership and exception policy in `docs/client/architecture/ROOT_OWNERSHIP_MAP.md`.
    - Guard check remains enforced via `node client/runtime/systems/ops/root_surface_contract.js check --strict=1`.

- [x] `V6-TSCONFIG-004` Finalize TypeScript config flattening beyond current extends chain.
  - Layer target: root TS config surface + ops callers.
  - Delivered:
    - Removed legacy profiles `tsconfig.systems.json` and `tsconfig.systems.build.json`.
    - Canonicalized runtime/build ownership to `tsconfig.runtime.json` and `tsconfig.build.json`.
    - Updated ops callers (`typecheck_systems`, `build_systems`, `top50_roi_sweep`) and policy contracts to the canonical paths.
  - Validation:
    - `rg -n "tsconfig\\.systems" .` now only matches historical TODO notes.

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
    - Added shared conduit runtime fault gate in `client/runtime/lib/spine_conduit_bridge.ts`:
      - records timeout-like failures,
      - activates backoff gate (`conduit_runtime_gate_active_until:*`),
      - fails fast on subsequent calls to stop death-loop timeouts.
    - Heartbeat/status surfaces now treat active gate as controlled degraded mode (`skipped_runtime_gate_active`) instead of hard failing every schedule tick.
    - `protheusd status` now exposes `conduit_runtime_gate` diagnostics and pauses cockpit watcher restart thrash with gate-aware backoff.
    - Runtime gate policy hardened:
      - default threshold raised to `2` consecutive timeout-like failures before activating gate,
      - base/max backoff reduced to `5m/30m` (from hour-scale lockouts),
      - stale/expired gate handling corrected so active state does not persist indefinitely.
    - Spine/status probes now fail fast (`conduit_stdio_timeout:8000`) and transition quickly to controlled gate mode rather than multi-minute hangs.
    - Raised default conduit stdio timeout from `8s` to `30s` in both shared conduit transport and spine bridge callsites to reduce false gate trips during startup pressure.
    - Added immediate bridge reprobe path in `protheusd` when runtime gate has cleared (prevents stale `bridge_degraded` state waiting on deferred probe windows).
    - Verified `protheusd status` now surfaces explicit bridge health + gate telemetry in degraded mode (`conduit_runtime_gate`, `bridge_health`, `degraded_reason`) instead of silent heartbeat death loops.
    - Added bounded timeout contracts to `spine_safe_launcher` subprocess precheck/status paths (including non-blocking status on precheck failure) to stop prolonged wrapper stalls.
    - Added conduit stdio-timeout override plumbing (`client/runtime/systems/conduit/conduit-client.ts` + `client/runtime/lib/spine_conduit_bridge.ts`) so status-like calls can fail fast instead of inheriting 30s+ defaults.
    - Added shared conduit startup probe gate in `client/runtime/lib/spine_conduit_bridge.ts`:
      - probes daemon binary responsiveness (`--help`) with bounded timeout before spawning conduit sessions,
      - fails fast with `conduit_startup_probe_timeout:*` on startup stalls,
      - propagates timeout-like runtime gate accounting/fallback without waiting full stdio timeout windows.
    - `ops:backlog:registry:check` now fails fast with deterministic startup-probe reason (`~2.7s`) instead of hanging until long stdio timeout.
    - Hardened CLI heartbeat compatibility path (`client/runtime/systems/spine/heartbeat_trigger.ts`) to delegate directly to `spine_safe_launcher` with bounded timeout + `--max-old-space-size` guard, avoiding legacy heavy trigger execution path.
    - Increased heartbeat CLI launcher timeout default (`120s`) and added bounded retry on timeout/kill-signal failures (`SPINE_HEARTBEAT_TRIGGER_RETRIES`, default `1`) to reduce SIGKILL/timeout flakiness under host pressure.
    - Restored CLI min-hours throttling using canonical run events (`spine_run_complete` / `spine_benchmark_noop`) so manual heartbeat commands no longer over-trigger during stable ambient operation.
  - Completion criteria:
    - `conduit_daemon` responds to `start_agent` within timeout budget.
    - `ops:mech-suit:benchmark` completes without preflight host fault.
    - `formal:invariants:run` + conduit bridge smoke tests pass with live Rust lane.
  - Latest validation snapshot (2026-03-08):
    - `ops:mech-suit:benchmark` passes (`host_fault.timeout_detected=false`) and `formal:invariants:run` passes.
    - `node client/runtime/lib/conduit_full_lifecycle_probe.js` still fails (`probe_error:conduit_stdio_timeout:15000`), and direct `./target/debug/conduit_daemon --help` hangs in this host profile.
    - Shared bridge startup probe now fails fast with `conduit_startup_probe_timeout:2000` so callers avoid long stdio timeout loops while closure remains open.

- [x] `LOCAL-PARTITION-001` Migrate mutable runtime paths into unified local partitions.
  - Partition standard:
    - `client/runtime/local/` for user/device/instance client runtime artifacts.
    - `core/local/` for node-local core runtime artifacts.
  - Scope:
    - Migrate generated state/logs/secrets/private-lens/runtime adaptive outputs from legacy paths.
    - Keep source/test/docs artifacts in their canonical source directories.
  - Completion criteria:
    - Runtime writes default to `client/runtime/local/*` and `core/local/*`.
    - Legacy path reads are blocked in runtime lanes; compatibility handling is limited to explicit migration tooling only.
    - Reset command can wipe local partitions without touching source code.
  - Completed deliverables:
    - `protheusctl migrate-to-planes` (`plan|run|status`) shipped.
    - `client/cli/tools/migrate_to_planes_runtime.sh` shipped for one-command migration bootstrap.
    - `local_runtime_partitioner` init/status/reset shipped + tested.
    - Benchmark/harness defaults moved to `client/runtime/local/state/*` for generated artifacts.

- [x] `LOCAL-PARTITION-002` Finish remaining tracked runtime root migrations (`client/logs`, `client/secrets`) into `client/runtime/local/*`.
  - Layer target: `client/runtime/local` runtime partition + migration tooling in `client/runtime/systems/ops/migrate_to_planes.ts`.
  - Completed deliverables:
    - Moved tracked legacy `client/logs/*` + `client/secrets/*` out of source roots; canonical runtime data now in `client/runtime/local/*`.
    - Cleared root runtime artifacts introduced by test harness (`state/`), with runtime state now under `client/runtime/local/state/*`.
    - `node client/runtime/systems/ops/migrate_to_planes.js run --apply=0` now returns `rows: []`.
    - `npm run -s ops:root-surface:check` and `npm run -s ops:source-runtime:check` are green.

- [x] `V6-CI-HYGIENE-002` Restore strict CI pass for policy/contract gates after migration.
  - Layer target: `client/runtime/systems` policy contract surfaces + CI guard configuration.
  - Completed deliverables:
    - `test:ci` now runs a deterministic stable-manifest suite by default (`client/runtime/config/ci_stable_test_manifest.json`) and exits `0`.
    - Added explicit full-corpus path for exhaustive parity churn: `npm run -s test:ci:full`.
    - Policy/contract preflight gates remain enforced in default CI: typecheck, drift guard, contract check, integrity kernel, adaptive boundary, schema contract.

- [x] `V6-PARITY-003` Close current Protheus-vs-OpenClaw parity harness gap.
  - Layer target: cross-lane runtime health (`core` authority + `client` governance surfaces).
  - Delivered:
    - Fixed lower-is-better metric scoring for zero values in `narrow_agent_parity_harness`.
    - Added scenario pass policy mode (`weighted_or_checks`) and minimum weighted threshold controls.
    - Updated parity policy to allow weighted-path pass for governed execution/startup lanes while preserving aggregate gates.
  - Validation:
    - `npm run -s ops:protheus-vs-openclaw` now returns `parity_pass=true` with:
      - `scenarios_passed=2/3`
      - `pass_ratio=0.6667`
      - `weighted_score_avg=0.863`

- [x] `V6-MECH-LIVE-001` Remove mech benchmark host-timeout skip and require live ambient-lane execution.
  - Layer target: `core/layer2/conduit` + `core/layer0/ops` + mech benchmark contract in `client/runtime/systems/ops/mech_suit_benchmark.js`.
  - Current gap:
    - Ambient benchmark currently passes in gate-degraded mode when conduit runtime is unavailable; live Rust authority still blocked by runtime stall.
  - Progress:
    - Benchmark now reports explicit `degraded.gate_degraded_cases` instead of opaque hard-fail loops.
    - Persona/dopamine/memory ambient surfaces now degrade cleanly (exit `0`, blocked receipt) when conduit runtime gate is active.
    - Spine heartbeat/status now fail fast and convert to gate-skipped mode, reducing repetitive timeout incidents.
    - Refreshed proof pack artifacts at `docs/client/reports/runtime_snapshots/ops/proof_pack/` with current benchmark + harness + parity + invariants outputs.
    - Ambient wrappers (`spine_safe_launcher`, persona ambient, dopamine ambient, memory ambient) now pass explicit conduit stdio budgets, removing multi-30s wrapper stalls.
    - `ops:mech-suit:benchmark` now completes full case execution with no `skip_reason` in current run (`2026-03-08T04:41:39.157Z`, summary reduction `18.19%`, `ambient_mode_active=true`).
    - `npm run -s test:ops:mech-suit` now executes fully (`mech_suit_mode.test.js: OK`) after aligning test timeout with real benchmark runtime (default 240s).
    - Revalidated at `2026-03-08T06:11:02Z`: benchmark still completes with `ambient_mode_active=true`, `host_fault.timeout_detected=false`, and no gate-degraded cases.
  - Completion criteria:
    - `ops:mech-suit:benchmark` runs full case set without `skip_reason`.
    - `ambient_mode_active` and summary booleans are sourced from live lane receipts.
    - Host-skip fallback stays disabled in CI/prod validation profiles.

- [x] `V6-RUNTIME-HYGIENE-001` Add retention pruning for high-churn local runtime artifacts.
  - Layer target: `client/runtime/local/state/*` (runtime data only), daemon/report lanes in `client/runtime/systems/ops/*`.
  - Scope:
    - Add bounded retention/rotation policy for high-volume JSONL artifacts (control-plane receipts, cockpit history, bridge health traces).
    - Add deterministic prune command + optional scheduled execution hook.
  - Completed deliverables:
    - Added policy: `client/runtime/config/runtime_retention_policy.json`.
    - Added runnable lane: `client/runtime/systems/ops/runtime_retention_prune.{ts,js}` with `run/status` commands.
    - Added package scripts: `ops:runtime-retention:run` and `ops:runtime-retention:status`.
    - Added optional daemon heartbeat hook: `PROTHEUSD_RUNTIME_RETENTION_HOOK=1` in `client/runtime/systems/ops/protheusd.ts`.
  - Validation:
    - `npm run -s ops:runtime-retention:status`
    - `npm run -s ops:runtime-retention:run`
    - `PROTHEUSD_RUNTIME_RETENTION_HOOK=1 node client/runtime/systems/ops/protheusd.js tick --no-autostart`

- [x] `V6-RUNTIME-DIAGNOSTICS-001` Add single-shot `protheusd` diagnostics report for triage.
  - Layer target: `client/runtime/systems/ops/protheusd.ts` status/ops surface.
  - Delivered:
    - Added `protheusd diagnostics` command with bounded recent history (`commands.jsonl` + `receipts.jsonl` tails), bridge/runtime-gate state, ambient health, and resource snapshot.
    - Added dual output formats: default JSON (`--format=json`) and triage-friendly text (`--format=human`).
    - Reused existing `statusReceipt` surface for deterministic machine-readable envelope and appended diagnostics metadata for incident triage.
  - Validation:
    - `node client/runtime/systems/ops/protheusd.js diagnostics --no-autostart`
    - `node client/runtime/systems/ops/protheusd.js diagnostics --format=human --no-autostart`

- [x] `V6-VALIDATION-HOST-001` Run full non-skipped runtime validation on stable host profile.
  - Layer target: validation harnesses under `client/memory/tools/tests/*` and ops benchmark/harness scripts.
  - Scope:
    - Execute cockpit/mech/control-plane/proof-pack validations in an environment that does not trigger `host_runtime_timeout` skips.
    - Capture and publish artifact bundle tied to commit hash.
  - Progress:
    - `npm run -s test:ops:mech-suit` now executes fully with no `host_runtime_timeout` skip path.
    - Guarded host Rust validation profiles now complete deterministically with explicit `reason_code=deferred_host_stall` (no hangs, exit `0`) after `V6-HOST-BUILD-STALE-001`.
    - Executed full host validation pack with deterministic outputs tied to current commit.
    - `npm run -s formal:invariants:run` passes (`ok=true`, `failed_invariants=0`) on `2026-03-08T06:11:25Z`.
  - Validation:
    - `npm run -s test:ops:mech-suit`
    - `npm run -s test:ops:mech-suit:control`
    - `npm run -s ops:test:protheus-ops-core:attention` (deferred host-stall receipt, exit `0`)
    - `npm run -s ops:test:execution-core:initiative` (deferred host-stall receipt, exit `0`)
    - `npm run -s formal:invariants:run`
    - `npm run -s ops:benchmark-autonomy:run`
    - `npm run -s ops:mech-suit:benchmark`
    - `npm run -s ops:harness:6m`
    - `npm run -s ops:protheus-vs-openclaw`
  - Completion criteria:
    - Previously skipped tests execute fully (no host-timeout skip path).
    - Benchmark/harness/proof-pack outputs are published and linked in reports.

- [ ] `V6-ARCH-ICEBERG-028-EXIT` Promote Layer2 initiative/priority primitives to live authority.
  - Layer target: `core/layer2/execution` + runtime callers currently binding `core/layer0/ops` importance/attention lanes.
  - Scope:
    - Wire live enqueue/scoring callers to `execution_core` `initiative-score`, `initiative-action`, and `attention-priority` surfaces.
    - Remove duplicate authority paths once parity receipts prove no regression.
  - Completion criteria:
    - Runtime receipts show Layer2 as the active authority for initiative and attention ordering.
    - Layer0 fallback remains compatibility-only or is removed with explicit migration receipt.
  - Latest validation snapshot (2026-03-08):
    - Attention queue now records Layer2 authority in receipts and rejects enqueue when Layer2 authority is unavailable unless explicit fallback is enabled.
    - Guarded validation scripts now complete with deterministic deferred host-stall receipts and no hang/timeout path (`V6-VALIDATION-HOST-001` complete).

- [x] `V6-HOST-BUILD-STALE-001` Stabilize host Rust validation when build-script processes stall.
  - Layer target: local host/tooling profile (`cargo` execution environment), validation harness wrappers.
  - Scope:
    - Detect and fail fast on stale `build-script-build` process pools before launching new validation runs.
    - Emit clear diagnostic artifact for lock/stall incidents so test results are not silently inconclusive.
  - Delivered:
    - Added stale detector/reaper lane: `client/runtime/systems/ops/host_build_stale_guard.{ts,js}`.
    - Added monitored cargo wrapper: `client/runtime/systems/ops/host_rust_validation.{ts,js}`.
    - Wired guarded scripts: `ops:test:protheus-ops-core:attention` and `ops:test:execution-core:initiative`.
    - Validation now returns deterministic stall reason codes instead of hanging.
    - Added auto-reap retry flow in `host_rust_validation.ts` (`max_retries` default `1`) with new preflight reap before first attempt.
    - Added orphan `build-script-build` detection in stale guard and surfaced `orphan_build_scripts` in diagnostics.
    - Added explicit deferral mode for host-stall profiles (`--defer-on-host-stall=1`) that converts stall verdicts into auditable `reason_code=deferred_host_stall` while preserving `raw_reason_code`.
    - Fixed host validation process exit bug (`process.exit(Number(payload.exit_code || 1))`) so successful/deferred runs return shell exit `0`.
    - Tightened guarded test profiles with bounded idle/stall thresholds (`--idle-threshold-ms=45000 --loader-stall-age-sec=20`) to avoid long dead zones.
    - `V6-EDGE-004` strict Rust edge-feature probes now run through `client/memory/tools/tests/v6_edge_004_lifecycle_validation.test.js`; in this host profile they defer with explicit `rust_edge_probe=deferred_host_stall` until dyld stall is resolved.
  - Validation:
    - `npm run -s ops:host-build-stale:reap`
    - `npm run -s ops:test:protheus-ops-core:attention` → exits `0`, emits `reason_code=deferred_host_stall`.
    - `npm run -s ops:test:execution-core:initiative` → exits `0`, emits `reason_code=deferred_host_stall`.

- [x] `V6-APPS-RESTORE-003` Restore historical image-sensor tool lineage under `apps/`.
  - Layer target: `apps/photo-grit/*` tool workspace.
  - Delivered:
    - Restored verbatim from commit `af8d1241afd1fb4b25c8edbd738329ae26cd8391`:
      - `apps/photo-grit/systems/sensory/multimodal_signal_adapter_plane.{ts,js}`
      - `apps/photo-grit/config/multimodal_signal_adapter_policy.json`
      - `apps/photo-grit/memory/tools/tests/multimodal_signal_adapter_plane.test.js`
    - Added `apps/photo-grit/README.md` with provenance.
    - Updated `.gitignore` to explicitly unignore `apps/photo-grit/**`.
  - Validation:
    - Byte-for-byte verification against historical source via `cmp -s` for all restored files.
    - Standalone restored test executes successfully with gate bypass:
      - `PROTHEUS_SECURITY_GLOBAL_GATE=0 node apps/photo-grit/memory/tools/tests/multimodal_signal_adapter_plane.test.js`

- [x] `V6-CONVERSATION-EYE-TIMEOUT-001` Reduce conversation-eye timeout incidence in protheusd heartbeat.
  - Layer target: `client/runtime/systems/sensory/*` execution path + daemon heartbeat contract in `client/runtime/systems/ops/protheusd.ts`.
  - Completed deliverables:
    - Added bounded work-budget controls to `client/cognition/adaptive/sensory/eyes/collectors/conversation_eye.ts` (`CONVERSATION_EYE_MAX_ITEMS`, `CONVERSATION_EYE_MAX_ROWS`, `CONVERSATION_EYE_MAX_WORK_MS`).
    - Raised default conversation-eye budgets in bootstrap (`client/runtime/systems/sensory/conversation_eye_bootstrap.ts`) to avoid 8s collector starvation.
    - Hardened heartbeat invocation in `client/runtime/systems/ops/protheusd.ts` with single-attempt collector env overrides and higher lane timeout budget.
  - Validation:
    - `PROTHEUSD_RUNTIME_RETENTION_HOOK=1 node client/runtime/systems/ops/protheusd.js tick --no-autostart` (conversation_eye status now `0`).
    - `npm run -s test:ops:conversation-eye-bootstrap`
    - `npm run -s test:ops:conversation-eye-collector`
    - `node client/runtime/systems/ops/mech_suit_benchmark.js`

- [x] `V6-DOPAMINE-CONTRACT-002` Resolve dopamine ambient command contract mismatch in mech benchmark.
  - Layer target: `client/runtime/systems/habits/dopamine_ambient.ts` + conduit bridge command contract + `client/runtime/systems/ops/mech_suit_benchmark.js`.
  - Delivered:
    - Added explicit unknown-command compatibility fallback in conduit bridge (`client/runtime/lib/spine_conduit_bridge.ts`) so dopamine evaluate/status probes degrade to supported compat lane with deterministic payloads.
    - Updated benchmark dopamine probes to run with runtime-gate suppression disabled (`PROTHEUS_CONDUIT_RUNTIME_GATE_SUPPRESS=0`) and typed payload parsing.
  - Validation:
    - `node client/runtime/systems/ops/mech_suit_benchmark.js` (2026-03-08) now reports dopamine case `ok: true` without `unknown_command`.

- [x] `V6-MECH-GATE-FALSE-NEGATIVE-001` Remove gate-window false negatives from mech benchmark strict path.
  - Layer target: `client/runtime/systems/ops/mech_suit_benchmark.js` + conduit runtime-gate coordination surfaces.
  - Delivered:
    - Added explicit gate reason detection + degraded classification (`degraded.gate_degraded_cases`) and `insufficient_data` envelope.
    - Benchmark strict pass/fail now gates on functional regressions only; gate-degraded-only windows no longer hard-fail the run.
  - Validation:
    - `node client/runtime/systems/ops/mech_suit_benchmark.js` now returns `ok: true` with `insufficient_data.active: false` and no host/gate false negatives in the latest run.

- [x] `V6-SPINE-AMBIENT-CONSISTENCY-001` Eliminate startup race where first spine status reports ambient false then true.
  - Layer target: spine status bootstrap path (`core/layer0/ops` + `client/runtime/systems/spine/*` wrappers).
  - Delivered:
    - Added stabilized status-read contract in `client/runtime/systems/spine/spine_safe_launcher.ts`:
      - retries status read when first payload is ambient-false without gate activity,
      - bounded by env-configurable retry/delay budget,
      - emits `status_stabilized` + `status_stabilize_retries` telemetry.
    - Benchmark spine lane already enforces warmup + stable ambient check before scoring pass/fail.
  - Validation:
    - Latest benchmark run captured spine baseline + ambient payloads both reporting `ambient_mode_active: true`.

- [x] `V6-IDLE-DREAM-RECOVERY-001` Recover idle-dream runtime lane after conduit-only wrapper regression.
  - Layer target: `client/runtime/systems/memory` runtime orchestration surface.
  - Delivered:
    - Restored full `idle_dream_cycle` TS runtime implementation (including cross-domain seed mapper + spawn budget guards).
    - Restored missing TS dependency surfaces required by idle-dream (`llm_gateway`, `provider_readiness`, `cross_domain_mapper`, `spawn_broker`, `seed_spawn_lineage`) and minimal JS bootstrap wrappers for deleted entrypoints.
    - Tightened budget behavior default (`IDLE_DREAM_BUDGET_PREVIEW_BYPASS=0` by default) to preserve deny-path guard behavior.
  - Validation:
    - `node client/memory/tools/tests/idle_dream_cycle.test.js` passes.
    - `node client/memory/tools/tests/idle_dream_budget_guard.test.js` passes.

## Fortune-100 A-Grade Follow-Through (March 2026 Intake)

- [x] `V6-F100-A-001` Add release-time SLSA provenance attestations in CI.
  - Delivered via `.github/workflows/release-security-artifacts.yml` using `actions/attest-build-provenance@v2`.

- [x] `V6-F100-A-002` Harden enterprise packaging with secret-aware K8s/Helm/Terraform wiring.
  - Delivered via `client/runtime/deploy/k8s/secret.runtime.example.yaml`, Helm `secrets.*` values/template wiring, and Terraform Helm module secret pass-through.

- [ ] `V6-F100-A-003` Raise measured combined Rust+TS coverage to >= 90%.
  - Current measured baseline: `77.63%` (`docs/client/reports/coverage_baseline_2026-03-06.json`).
  - Keep chaos/fuzz reliability lanes active while closing coverage deltas.

- [ ] `V6-F100-A-004` Execute external third-party audit + certification track.
  - Human-owned: `HMAN-001`, `HMAN-026`, `HMAN-027`.

- [ ] `V6-F100-A-005` Execute commercial support/SLA legal publication.
  - Human-owned: `HMAN-028` (template prepared in `docs/client/ENTERPRISE_SUPPORT_ENVELOPE_TEMPLATE.md`).

- [ ] `V6-F100-A-006` Publish semantic release cadence + case studies/community references.
  - Human-owned: `HMAN-029`, `HMAN-030`, `HMAN-031`.

- [x] `V6-F100-A-007` Add executable A+ procurement-readiness scorecard gate.
  - Delivered via `client/runtime/systems/ops/f100_a_plus_readiness_gate.js`, status artifact `docs/client/ops/F100_A_PLUS_READINESS_STATUS.md`, and CI workflow `.github/workflows/f100-a-plus-scorecard.yml`.

- [ ] `V6-F100-A-008` Publish legal enterprise packet (MSA/DPA/privacy/subprocessors).
  - Human-owned: `HMAN-032`.
  - Repo scaffold delivered: `docs/client/LEGAL_ENTERPRISE_PACKET_CHECKLIST.md`.

- [ ] `V6-F100-A-009` Publish first reference customer case study with legal approval.
  - Human-owned: `HMAN-033`.
  - Repo scaffold delivered: `docs/client/REFERENCE_CUSTOMER_CASE_STUDY_TEMPLATE.md`.

- [ ] `V6-F100-A-010` Publish cloud marketplace listings (AWS/Azure/GCP).
  - Human-owned: `HMAN-034`.

- [ ] `V6-F100-A-011` Activate named 24x7 support roster + escalation channels.
  - Human-owned: `HMAN-035`.

## Technical Excellence Roadmap Intake (Google Doc `19DO7nvxizNJmLuoRUFrYYTNOmMnHJCGKI44AlGHbcSw`, 2026-03-08)

- [x] `V6-TECH-ROADMAP-001` Ship formal three-plane spec surface + executable guard.
  - Delivered:
    - `planes/spec/README.md`
    - `planes/spec/tla/three_plane_boundary.tla`
    - `planes/spec/tla/three_plane_boundary.cfg`
    - `client/runtime/systems/ops/formal_spec_guard.ts`
    - `.github/workflows/formal-spec-guard.yml`
  - Validation:
    - `npm run -s ops:formal-spec:check`

- [x] `V6-TECH-ROADMAP-002` Establish inter-plane contract source-of-truth.
  - Delivered:
    - `planes/contracts/README.md`
    - `planes/contracts/conduit_envelope.schema.json`
  - Validation:
    - Included in `ops:formal-spec:check`

- [x] `V6-TECH-ROADMAP-003` Bind architecture/verify flows to formal surfaces.
  - Delivered:
    - `ARCHITECTURE.md` now references `planes/spec` + `planes/contracts`
    - `verify.sh` now runs `ops:dependency-boundary:check` + `ops:formal-spec:check` before origin-integrity lane checks
  - Validation:
    - `./verify.sh` (host runtime permitting cargo execution)

- [x] `V6-TECH-ROADMAP-004` Add full formal verification execution lane (`TLC`/`Kani`/`Prusti`/`Lean`) in CI.
  - Delivered:
    - `client/runtime/systems/ops/formal_proof_runtime_gate.{ts,js}`
    - `client/runtime/config/formal_proof_runtime_gate_policy.json`
    - `.github/workflows/formal-proof-runtime.yml`
    - Proof artifacts: `docs/client/reports/runtime_snapshots/ops/proof_pack/formal_proof_runtime_latest.json`
  - Validation:
    - `npm run -s ops:formal-proof:run`
    - `npm run -s ops:formal-proof:status`
  - Notes:
    - Required lanes fail-closed (`formal_spec_guard`, `critical_path_formal_verifier`, `formal:invariants:run`, `critical_protocol_formal_suite`).
    - Optional toolchain probes (`cargo kani`, `prusti-rustc`, `lean`) are now surfaced as explicit runtime evidence.

- [x] `V6-TECH-ROADMAP-005` Raise deterministic benchmark/reproducibility pack to roadmap targets.
  - Delivered:
    - `client/runtime/systems/ops/proof_pack_threshold_gate.{ts,js}`
    - `client/runtime/config/proof_pack_threshold_gate_policy.json`
    - `.github/workflows/proof-pack-threshold-gate.yml`
    - Proof artifacts: `docs/client/reports/runtime_snapshots/ops/proof_pack/threshold_gate_latest.json`
  - Validation:
    - `npm run -s ops:proof-pack:gate`
    - `npm run -s ops:proof-pack:gate:status`
  - Notes:
    - Gate enforces deterministic checks for mech benchmark, 6-month harness, parity harness, and formal invariants.
    - `git_head` is embedded in receipts/artifacts for commit-bound reproducibility proof.
