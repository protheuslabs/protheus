# Memory Ambient Audit - 2026-03-07

## Scope

- Audited memory lane for ambient operation, authority ownership, and manual orchestration.
- Implemented Rust-authoritative memory ambient lane and conduit routing for TS surfaces.

## Implemented

1. Added Rust `memory-ambient` domain (`core/layer0/ops/src/memory_ambient.rs`).
2. Added conduit message type `memory_ambient_command` and bridge execution in `core/layer2/conduit/src/lib.rs`.
3. Added JS conduit bridge helper `runMemoryAmbientCommand` (`client/lib/spine_conduit_bridge.js`).
4. Added thin memory ambient surface (`client/systems/memory/ambient.js`).
5. Converted `client/systems/memory/index.js` to conduit-first routing with explicit compat mode fallback (`PROTHEUS_MEMORY_COMPAT_MODE`).
6. Routed cockpit harness snapshots to include memory status (`client/systems/ops/cockpit_harness.ts`).
7. Added memory case to mech suit benchmark (`client/systems/ops/mech_suit_benchmark.js`).
8. Added requirements doc (`client/docs/requirements/memory_ambient_requirements.md`).

## Remaining Split Points

### Runtime split points (still direct memory-cli authority paths)

- `core/layer0/memory_abstraction/src/main.rs`

### Non-runtime/documentation split points

- `package.json` scripts and docs that intentionally call `memory-cli` for parity/build verification.
- `client/config/napi_build_surface_compat_policy.json` keeps `cli_compat` as an explicit diagnostics-only profile.

## Low-effort split-point cleanup completed

1. `client/systems/security/psycheforge/temporal_profile_store.ts` now writes hot state through `client/systems/memory/index.js` (ambient conduit lane) by default; legacy CLI fallback is opt-in (`allow_legacy_cli_fallback`).
2. `client/systems/security/psycheforge/_shared.ts` now declares `rust_memory.transport=memory_surface_ambient` and compatibility fallback policy.
3. `client/systems/memory/observational_compression_layer.ts` policy metadata now reflects conduit-first transport, with legacy `memory-cli` fields marked compatibility-only.
4. `client/config/napi_build_surface_compat_policy.json` probe command now targets `protheus-ops memory-ambient status` (Rust ambient authority); direct `memory-cli` remains only in `cli_compat`.

## Validation

- `cargo check -p protheus-ops-core` ✅
- `cargo check -p conduit` ✅
- `npm run -s formal:invariants:run` ✅

## Runtime blocker in this host

- Full benchmark and runtime integration tests time out due local Rust executable hang (observed on `target/debug/protheus-ops ...` invocations).
- Root-cause signals captured from host logs:
  - `amfid`: adhoc/unknown certificate chain validation failures for local binaries.
  - `syspolicyd`: repeated `Unable to initialize qtn_proc` and `dispatch_mig_server returned 268435459`.
  - `syspolicyd`: `MacOS error: -67062` and notarization daemon errors during provenance evaluation.
- Last available benchmark artifact remains at `state/ops/mech_suit_benchmark/latest.json`.

## Recommended next cleanup

1. Migrate `core/layer0/memory_abstraction` surface to `memory-ambient` authority path.
2. Keep direct `memory-cli` paths only for explicit parity/build verification scripts, then sunset them behind a single compat gate.
3. Re-run full benchmark + memory runtime integration tests after host syspolicy remediation to close runtime proof gap.
