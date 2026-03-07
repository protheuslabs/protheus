# client/local

Instance-specific client runtime data lives here.

Purpose:
- Keep user/device/instance mutable artifacts out of source directories.
- Make reset operations safe (`client/local` can be wiped without touching code).
- Keep open-source surface clean while preserving local runtime behavior.

Typical contents:
- `adaptive/` runtime-generated adaptive state
- `memory/` local memory/runtime artifacts
- `logs/`, `reports/`, `research/`, `patches/`
- `secrets/` and local config overrides
- `state/` client-side runtime state snapshots

Rules:
- Source code does not belong in this tree.
- Treat this directory as local-only and non-authoritative for source.
