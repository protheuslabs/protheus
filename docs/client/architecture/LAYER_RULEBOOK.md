# InfRing Layer Rulebook — Strict Enforcement Policy
**Version 1.2** — March 2026  
**This is the source of truth for file placement, language boundaries, and layer ownership. No deviations without explicit user approval.**

### 1. Directory Split (Enforced)
The repository has six top-level product/code roots:
- `/core` — deterministic core stack (`layer_minus_one`, `layer0`, `layer1`, `layer2`, `layer3`) and trusted low-level logic.
- `/client` — developer-facing platform, SDKs, CLI, dashboards, and thin wrappers.
- `/packages` — public SDK/package distribution surfaces, starter bundles, and installable developer-facing wrappers.
- `/apps` — end-user applications built on top of the client/platform surface.
- `/adapters` — integration shims for external apps, services, and systems that were not originally designed for InfRing.
- `/tests` — integration, end-to-end, regression, and system verification surfaces.

All product code should live in one of these roots.

Allowed root-level exceptions (metadata/infrastructure): `.github/`, `.githooks/`, policy/docs, `scripts/`, `examples/`, `benchmarks/`, lockfiles, build manifests, deploy manifests, generated artifacts, and runtime state directories.

### 1.1 Placement Rule (Authority First)
Placement is decided by authority before language.

- If a surface decides, enforces, records, budgets, schedules, or guards system truth, it belongs in `core`.
- If a surface exists to help developers call, inspect, visualize, package, or extend the system, it belongs in `client`.
- If a surface exists to ship the public SDK/package layer to developers, it belongs in `packages`.
- If a surface is an opinionated workflow/product on top of the platform, it belongs in `apps`.
- If a surface exists to connect InfRing to something external, legacy, or third-party, it belongs in `adapters`.
- If a surface exists only to verify behavior, it belongs in `tests` or adjacent unit-test locations.

### 2. Layer Definitions (Strict)
- **Layer -1 (Exotic Hardware Template)** — `/core/layer_minus_one/`  
  Thin adapter contract for exotic substrates; capability + fallback declarations only.

- **Layer 0 (Safety Plane / Immutable Origin)** — `/core/layer0/`  
  Constitution, deterministic receipts, invariant enforcement, security gates, and root safety authority.

- **Layer 1 (Policy + Deterministic Receipts)** — `/core/layer1/`  
  Deterministic policy interpretation and receipt shaping.

- **Layer 2 (Scheduling + Execution)** — `/core/layer2/`  
  Execution orchestration, deterministic scheduling, queue/runtime coordination.

- **Layer 3 (OS Personality Template)** — `/core/layer3/`  
  Traditional OS growth surface (process/VFS/drivers/syscalls/namespaces/network/userland isolation).

- **Cognition Plane (Unnumbered)** — `/client/`  
  TS/JS/Python/Shell/PowerShell/HTML/CSS surfaces for user-facing and probabilistic workflows.

### 2.1 Client Scope Contract (Developer-Only Surface)
Client code must be limited to:
1. SDK/wrapper surfaces that call core through conduit/lanes.
2. Developer experience tooling (CLI, templates, local orchestrators, diagnostics).
3. Developer-visible interfaces (observability UI, dashboards, docs, runbooks).
4. App construction and app hosting surfaces (`/apps` and client app glue).

Safety, policy, receipts, and system-truth authority remain in core.

### 2.2 Packages Scope Contract
Packages are the public distribution layer for InfRing-facing SDKs and starter surfaces.

- Packages may be polyglot.
- Packages may depend on stable `client` SDK/CLI/runtime-entry surfaces.
- Packages must not own policy, receipts, or canonical state.
- If a package starts making authority decisions, it is misplaced and must move into `core`.

### 2.3 Apps Scope Contract
Apps are not part of the platform core and are allowed to be more opinionated.

- Apps may be polyglot.
- Apps may depend on `client` SDK/CLI/UI surfaces.
- Apps must not become the canonical owner of policy, receipts, or core state.
- Apps should consume public platform contracts, not private core internals.

### 2.4 Adapters Scope Contract
Adapters exist to connect InfRing to non-native systems.

- Adapters may be polyglot.
- Adapters may wrap third-party APIs, local tools, legacy services, or external applications.
- Adapters must remain capability-scoped and must not bypass conduit/policy/receipt contracts.
- If an adapter starts owning system truth, it is misplaced and must move into `core`.

### 2.5 Tests Scope Contract
Tests are a separate verification surface, with one exception:

- Unit tests may remain close to the code they verify.
- Integration, regression, system, chaos, and end-to-end tests should prefer `/tests`.

### 3. Language Rules
- `/core/`: Rust by default; C/C++ allowed only for approved low-level performance-critical or hardware-adjacent modules; shell allowed only for tightly-scoped build/install/packaging wrappers and never as safety authority.
- `/client/`: target state is TS/TSX + HTML/CSS frontend surfaces. JS/Python/Shell/PowerShell are tolerated only for explicitly-audited legacy shims, packaging helpers, or migration debt.
- `/packages/`: public SDK/package layer; polyglot is allowed, but packages stay thin and developer-facing.
- `/apps/`: polyglot by design.
- `/adapters/`: polyglot by design.
- `/tests/`: polyglot by design.
- No Rust/C/C++ in `/client/`.
- No TS/JS/Python/Shell in `/core/`.
- No JS/TS duplicate feature pairs. If both exist, TS is canonical and JS must be removed unless installer/deploy legacy is explicitly documented.
- No runnable app code under `client/cli/apps/`; runnable apps and demos must live under top-level `/apps`.

### 3.1 Public Platform Contract
The extension boundary for apps and adapters is:

- Conduit / lane-based runtime contract
- Client SDK/CLI/UI surfaces derived from that contract
- Explicit manifests and schemas

Apps and adapters should build against the contract, not against private implementation files.

### 4. Boundary Rules (Enforced)
- Client <-> core communication is conduit + scrambler only.
- Packages <-> core communication flows through public client/package contracts, never private authority backdoors.
- No direct client-side policy authority over core decisions.
- Apps/adapters must reach authority through platform contracts, not by importing private core internals.
- No direct back-channels, raw state bypasses, or legacy bridges around conduit.
- Layer flow is upward-only:
  `Layer -1 -> Layer 0 -> Layer 1 -> Layer 2 -> Layer 3 -> Cognition`.

### 5. Runtime Data Placement
- Client runtime/user/device/instance data: `client/runtime/local/`.
- Core runtime/user/device/instance data: `core/local/`.
- Source trees remain stable and reviewable; runtime churn never defines architecture authority.

### 6. Enforcement Rules
- No layer ownership changes without explicit user approval and audit note.
- CI/guards must fail on boundary violations.
- Architecture docs (`ARCHITECTURE.md`, `docs/SYSTEM-ARCHITECTURE-SPECS.md`, this rulebook) must remain synchronized.
- Client boundary audit:
  - `npm run -s ops:client-layer:boundary`
  - policy: `client/runtime/config/client_layer_boundary_policy.json`
- Repo surface audit:
  - `npm run -s ops:repo-surface:audit`
  - policy: `client/runtime/config/repo_surface_policy.json`
- Public platform contract audit:
  - `npm run -s ops:public-platform:contract`
  - policy: `client/runtime/config/public_platform_contract_policy.json`
- Client legacy debt inventory:
  - `npm run -s ops:client-legacy-debt:report`
  - emits a path-classified migration ledger for non-TS client debt
- Default verification path:
  - `./verify.sh` must run boundary + repo-surface + public-platform contract gates before origin-integrity checks

This rulebook is a live constitution artifact and must be kept aligned with the layered stack contract.
