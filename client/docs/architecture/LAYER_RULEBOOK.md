# InfRing Layer Rulebook — Strict Enforcement Policy
**Version 1.0** — March 2026  
**This is the single source of truth for file placement, language, and boundaries. No deviations allowed without explicit user permission.**

### 1. Directory Split (Enforced)
The repository must be split into exactly two top-level **source code** directories:
- `/core` — Rust + low-level languages only. Contains all protected layers, TCB, conduit server, scrambler, governance, and performance-critical code.
- `/client` — Surface layer only. Contains all user-facing code, extensions, UI, marketplace, SDKs, scripts, and thin conduit clients.

All actual source code must live under one of these two directories.

The following standard repo metadata and infrastructure items are explicitly allowed (and expected) to remain at the repository root:
- `.github/`
- `.githooks/`
- `.private-lenses/` (or any private config)
- `README.md`, `LICENSE`, `CONTRIBUTING.md`
- `Cargo.toml`, `package.json`, `Cargo.lock`, `pnpm-lock.yaml`
- Any build scripts, Dockerfiles, Helm charts, deploy configs, or CI files that are not source code.

These root-level items are exempt from the core/client rule and do not count as violations.

### 2. Layer Definitions (Strict)
- **Layer 0 (Core TCB)** — Rust + C/C++ only. Lives in `/core/layer0/`.  
  Primitives, conduit server, scrambler, governance, attention queue, memory ambient, dopamine ambient, persona ambient cache, spine authority, **and low-level C/C++ code (e.g. PicoLM edge brain)**.

- **Layer 1 (Resource Primitives)** — Rust only. Lives in `/core/layer1/`.

- **Layer 2 (Conduit + Ambient Logic)** — Rust only. Lives in `/core/layer2/`.

- **Client Surface (Layer 3)** — TS/JS/HTML/CSS/Python/Shell/PowerShell only. Lives in `/client/`.  
  All UI, marketplace, extensions, templates, thin conduit clients, SDKs, tests, deployment scripts, and user-facing tools.

### 3. Language Rules (Strict — No Exceptions)
- **Rust + C/C++ only** in `/core/` (all layers).  
  C/C++ is allowed **only** for low-level performance-critical code (e.g. PicoLM integration) and must stay in `/core/layer0/`.

- **TS/JS/HTML/CSS/Python/Shell/PowerShell only** in `/client/`.  
  - Shell scripts (`.sh`) and PowerShell (`.ps1`) belong exclusively in `/client/` (for installers, deployment, dev tools, and surface scripts).  
  - Python belongs exclusively in `/client/` (for SDKs, tools, scripts, extensions, and user-facing integrations).

- No JS/TS pairs anywhere. For any feature, choose one language and delete the other.
- Pair resolution override: if both `.ts` and `.js` exist for the same feature path, `.ts` is canonical and `.js` must be deleted unless the `.js` file is a true deployment/installer script or explicitly marked legacy.
- Never delete `.ts` files during migration without explicit user approval.
- Tests live in `/client/tests/` and may be JS/TS.
- No non-Rust/C++ languages are ever allowed in `/core/`.
- No Rust or C/C++ is ever allowed in `/client/`.

### 4. Boundary Rule (Enforced)
- The **only** way `/client/` talks to `/core/` is through the conduit + scrambler.
- No direct CLI execs, no file I/O, no legacy bridges, no raw state reads, no bypassing the conduit.
- All communication (including Python, Shell, PowerShell) must go exclusively through the conduit + scrambler.

### 5. Open-Source Benefit
- `/client/` is designed to be published as the open-source package (e.g. `@infring/client`).
- `/core/` remains closed and protected behind the quantum gate.

### 6. Migration & Enforcement Rules
- No layer changes without explicit user permission (tracked in audit log).
- New files must follow these rules immediately.
- Delete all JS/TS pairs and legacy bridges during migration.
- Add a CI gate that fails the build if any rule is violated.
- After migration, run full benchmark + formal:invariants:run.

This rulebook is the constitution of the codebase. All future work must obey it strictly.
