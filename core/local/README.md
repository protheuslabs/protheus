# core/local

Instance-specific core runtime data lives here.

Purpose:
- Isolate device/node-local core artifacts from authoritative source code.
- Enable deterministic reset of runtime state without mutating core implementation.

Typical contents:
- `state/` core runtime state snapshots
- `logs/` and diagnostic artifacts
- `memory/` local caches/checkpoints
- `config/` node-local overrides
- `cache/`, `device/` host-specific artifacts

Rules:
- No source code in this tree.
- Core authority remains in `core/layer*`; this is runtime-local storage only.
