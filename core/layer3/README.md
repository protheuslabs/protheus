# Layer 3 — OS Personality Template

Purpose:
- Host traditional operating-system personality contracts on top of the deterministic lower stack.

Scope examples:
- Process lifecycle and isolation model
- VFS/filesystem contract surface
- Driver registration and syscall dispatch surfaces
- Namespace, networking, and userland abstraction contracts

Rules:
- Consume lower-layer guarantees; do not bypass Layer 0 invariants.
- Upward-only flow: Layer 2 -> Layer 3 -> Cognition/Conduit surfaces.

Primary implementation:
- `core/layer3/os_extension_wrapper` (Rust crate)
