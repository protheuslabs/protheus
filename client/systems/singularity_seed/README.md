# Singularity Seed Lane

This lane treats Protheus as an open seed for crowdsourcing superintelligence.

Core loop set:
- `autogenesis_loop`
- `dual_brain_loop`
- `red_legion_loop`
- `blob_morphing_loop`

Each loop is materialized as a signed blob under `client/systems/singularity_seed/blobs/` and participates in a sovereignty-guarded cycle:

1. Freeze current loop state into blob.
2. Evolve deterministic next generation.
3. Unfold and verify evolved blob + signed manifest.
4. Fail closed if `max_drift_pct > 2.0`.
