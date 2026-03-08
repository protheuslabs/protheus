# exotic_wrapper (Layer -1)

Deterministic wrapper contracts for exotic substrate signals before they cross into Layer 0 authority.

- Input: `ExoticEnvelope`
- Output: `Layer0Envelope`
- Guarantees: deterministic digest, explicit degradation contract

This crate must remain policy-free and cognition-free.
