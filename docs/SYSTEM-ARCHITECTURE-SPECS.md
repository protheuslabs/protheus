# Protheus / InfRing Layering Specification
Version 1.0 — March 2026  
Status: Locked architecture contract (authoritative for layering, flow direction, and invariants)

## 1. Purpose
Define the permanent layered architecture that supports:
- infallible origin safety,
- unlimited exotic hardware growth,
- and expansion into a full traditional operating system,
while preserving strict upward-only information flow.

## 2. Core Principles (Non-Negotiable)
- Strict upward-only information flow: lower layers may emit to higher layers only.
- Layer 0 is sacred and immutable: no contract or invariant weakening.
- Two template layers:
  - Layer -1 for exotic/future hardware paradigms.
  - Layer 3 for full OS personality growth.
- Backward compatibility: existing behavior and proofs must remain valid.

## 3. Final Layer Stack

```text
Exotic Hardware (quantum, ternary, optical, DNA, neuromorphic, etc.)
        ↓
Layer -1: Exotic Hardware Template (thin adapter)
        ↓
Layer 0: Safety Plane (Rust core, immutable origin)
        ↓
Layer 1: Policy Engine + Deterministic Receipts
        ↓
Layer 2: Scheduling + Execution
        ↓
Layer 3: OS Personality Template
        ↓
Cognition Plane (TS/Python client surfaces)
```

## 4. Layer Responsibilities

### Layer -1 — Exotic Hardware Template (`core/layer_minus_one/`)
- Translates exotic primitives into the standard envelope contract expected by Layer 0.
- Must stay thin: trait + minimal adapter logic.
- Must declare capability metadata and degradation fallback.

### Layer 0 — Safety Plane (`core/layer0/`)
- Conduit/scrambler boundary validation, deterministic receipts, constitution enforcement, RSI gates, root invariants, self-audit primitives.
- Single source of truth for safety-state binding.
- Immutable public contract.

### Layer 1 — Policy + Deterministic Receipts (`core/layer1/`)
- Deterministic policy interpretation and receipt projection.
- Bridges Layer 0 invariants into execution/policy outcomes without weakening guarantees.

### Layer 2 — Scheduling + Execution (`core/layer2/`)
- Deterministic execution planning, lane scheduling, and bounded runtime coordination.
- Hosts queueing/execution orchestration primitives that feed Layer 3.

### Layer 3 — OS Personality Template (`core/layer3/`)
- Growth layer for process model, VFS/filesystems, driver contracts, syscall surfaces, memory management, namespaces, networking stack, userland isolation, and windowing.
- Must consume lower-layer contracts; never bypass them.

### Cognition Plane (`client/`)
- User-facing and probabilistic surfaces.
- Can propose/assist; cannot become root-of-correctness.
- Communicates with core only through conduit + scrambler.

## 5. Interface Contracts (Generation Targets)

### Layer -1 trait
```rust
pub trait ExoticSubstrate {
    fn execute_envelope(&self, envelope: &ConduitEnvelope) -> Result<Receipt, SafetyError>;
    fn declare_capabilities(&self) -> SubstrateCapabilities;
    fn degradation_fallback(&self) -> FallbackMode;
}
```

### Layer 3 trait
```rust
pub trait OSPersonality {
    fn create_process(&self, config: ProcessConfig) -> Result<ProcessId, OsError>;
    fn vfs_operation(&self, op: VfsOperation) -> Result<VfsResult, OsError>;
    fn register_driver(&self, driver: Box<dyn DeviceDriver>);
    fn syscall_handler(&self, call: Syscall) -> Result<SyscallResult, OsError>;
}
```

## 6. Data Flow Rules
- Exotic hardware -> Layer -1 only.
- Layer -1 -> Layer 0 only (standardized envelopes).
- Layer 0 -> Layer 1 -> Layer 2 -> Layer 3 only.
- Layer 3 -> Cognition plane only.
- No downward calls, no hidden back-channels, no bypass paths.

## 7. Migration Contract
1. Maintain `core/layer_minus_one/` and `core/layer3/` as first-class architecture directories.
2. Keep Layer 0 boot path compatible with an `ExoticSubstrate` adapter contract.
3. Expand Layer 3 as the OS personality growth surface (without mutating Layer 0 invariants).
4. Keep architecture docs and enforcement docs synchronized with this stack.
5. Add/maintain regression checks for flow direction and boundary integrity.

## 8. Preserved Invariants
- Layer 0 contract remains stable and proof-preserving.
- Receipts remain bound to Layer 0 state.
- Constitution + RSI gate authority stays at Layer 0.
- Self-audit remains active at Layer 0.

## 9. Implementation Status (March 2026 snapshot)
- Architecture contract updated to include Layer -1 and Layer 3.
- Executable wrappers are present:
  - `core/layer_minus_one/exotic_wrapper/` (exotic envelope + degradation contracts)
  - `core/layer3/os_extension_wrapper/` (OS extension envelope contracts)
- `core/layer0/kernel_layers` now exports Layer -1 and Layer 3 wrappers through compile-time features.
- Runtime migration of all lane authority to the final stack remains incremental and must preserve receipts/invariants at every step.
