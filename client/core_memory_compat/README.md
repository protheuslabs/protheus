# `core/memory` Compatibility Alias

This directory is a compatibility surface for external instructions that expect a
`core/memory` crate layout.

Canonical runtime implementation remains:

- `client/systems/memory/rust/` (authoritative Rust memory core)
- `client/systems/memory/memory_recall.ts` (TS runtime integration)

Use:

```bash
node core/client/memory/compat_bridge.js status
```

to inspect alias -> canonical path mapping.
