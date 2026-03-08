# Layer -1 — Exotic Hardware Template

Purpose:
- Provide thin adapters that translate exotic substrate primitives into the standard core envelope contract.

Contract:
- Accept typed envelopes from substrate-facing callers.
- Emit deterministic receipts/errors expected by Layer 0.
- Declare capability and degradation/fallback metadata.

Rules:
- Keep this layer minimal; no policy authority and no cognition logic.
- Upward-only flow: Layer -1 -> Layer 0.

Primary implementation:
- `core/layer_minus_one/exotic_wrapper` (Rust crate)
