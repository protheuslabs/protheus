# Protheus Dictionary of Novel Concepts

Alphabetical glossary of key breakthroughs and ideas in Protheus. Each entry includes definition, purpose, and references.

## Binary Blobs
- **Definition**: Large sections of code, logic, or state serialized into opaque, compressed binary files embedded at compile time (for example via Rust `include_bytes!`). Each blob is mapped through a manifest entry with stable ID and hash verification for unfolding.
- **Purpose**: Enables controlled freeze/unfold cycles for high-value logic, tamper-evident loading, and tighter runtime portability across Rust-first lanes.
- **References**: `core/layer0/memory_runtime/src/blob.rs`, `core/layer0/memory_runtime/src/blobs/`, `core/layer0/memory_runtime/src/blobs/manifest.blob`.

## Flux Field
- **Definition**: A dynamic systems abstraction for tracking pattern movement, drift, and convergence across memory and orchestration surfaces.
- **Purpose**: Supports emergence-aware control by treating system behavior as measurable flow over time, including correction pressure when drift exceeds guardrails.
- **References**: `client/systems/memory/abstraction/analytics_engine.ts`, `client/systems/memory/abstraction/memory_view.ts`, `client/systems/memory/abstraction/test_harness.ts`.

## Personas
- **Definition**: Structured cognitive profiles of team lenses stored as Markdown artifacts (`profile.md`, `correspondence.md`, `lens.md`) and used for multi-perspective reasoning.
- **Purpose**: Reduces single-lens decision drift and enables explicit arbitration across safety, measurement rigor, and rollout priorities.
- **References**: `personas/vikram_menon/`, `personas/priya_venkatesh/`, `personas/rohan_kapoor/`, `personas/jay_haslam/`, `client/systems/personas/cli.ts`, `personas/arbitration.md`.
