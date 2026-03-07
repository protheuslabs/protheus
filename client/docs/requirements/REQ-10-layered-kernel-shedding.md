# REQ-10 - Layered Kernel Shedding

Status: implemented  
Owner: core-runtime  
Last Updated: 2026-03-06

## Objective

Define and implement sheddable Rust kernel layers so Protheus/InfRing can compile down to constrained hardware targets without maintaining separate compatibility modes.

## Why

- Preserve Rust as source of truth while scaling portability from server-class to legacy/embedded devices.
- Eliminate runtime compatibility branching where compile-time feature selection is sufficient.
- Reduce binary size and memory footprint for low-capability hardware profiles.

## Layer Model

1. Layer 0 (`core`)
- Scheduler, receipts, constitution, base policy checks, capability enforcement.
- Must always be present.

2. Layer 1 (`resource_isolation`)
- Quotas, client/memory/resource controls, sandbox + taint boundaries.
- Optional for constrained targets.

3. Layer 2 (`conduit_execution`)
- Conduit transport, policy registry bindings, agent lifecycle controls.
- Optional for minimal builds.

4. Layer 3 (`observability_marketplace`)
- Full traces/metrics surfaces, extension marketplace, rich TS bridge surfaces.
- Optional for server/desktop only builds.

## Functional Requirements

1. Cargo feature topology
- Add deterministic feature graph (`layer0`, `layer1`, `layer2`, `layer3`) with monotonic dependencies.
- Default build targets full stack (`layer3`).

2. Compile-time shedding
- Higher-layer modules are compiled only behind explicit `#[cfg(feature = ...)]` gates.
- No runtime branching as substitute for compile-time exclusion.

3. Minimal build profile
- Provide a documented minimal build path equivalent to Layer 0 for constrained targets.
- Build must succeed without higher-layer feature flags.

4. Capability and policy safety
- Shedding upper layers must not weaken Layer 0 constitution/policy/receipt invariants.
- Receipt chain behavior remains deterministic in all layer profiles.

5. Docs + operator ergonomics
- Publish a build matrix with exact commands per profile (minimal, embedded, default/full).
- Document expected capability differences between profiles.

## Verification Requirements

1. Feature matrix CI checks
- At minimum, validate:
  - `layer0`
  - `layer2`
  - default/full (`layer3`)

2. Contract checks
- Ensure no gated module is referenced when the corresponding feature is disabled.
- Ensure core lane tests continue to pass in minimal profile where applicable.

3. Invariant checks
- Formal invariants gate remains green after feature-flag integration.

## Non-Goals

- Rewriting all runtime crates immediately.
- Introducing parallel compatibility-mode codepaths.
- Moving client/adaptive/user-flex surfaces into hard-kernel scope.

## Exit Criteria

- Root/workspace feature topology landed and documented.
- Layer-gated module boundaries implemented for targeted crates.
- Minimal layer build documented and reproducible.
- CI verifies all required profiles.
- Formal invariants and core checks remain green.

## Implementation (2026-03-06)

Code deliverables:
- `core/layer0/kernel_layers/Cargo.toml` with deterministic feature graph:
  - `layer0` -> `task`, `resource`
  - `layer1` -> `layer0` + `isolation`, `ipc`, `storage`, `update`
  - `layer2` -> `layer1` + `conduit`
  - `layer3` -> `layer2` + `protheus-observability-core-v1`
- `core/layer0/kernel_layers/src/lib.rs` with strict `#[cfg(feature = ...)]` exports per layer and profile monotonicity tests.
- Workspace member registration in root `Cargo.toml`.

Build matrix commands:
1. Minimal core profile (`layer0`):
   - `cargo test -p kernel_layers --no-default-features --features layer0`
2. Conduit execution profile (`layer2`):
   - `cargo test -p kernel_layers --no-default-features --features layer2`
3. Full default profile (`layer3`):
   - `cargo test -p kernel_layers`
