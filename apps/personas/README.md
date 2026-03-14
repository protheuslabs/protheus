# Persona App Surface

`apps/personas/` is reserved for shareable, productized persona app code.

- Do not store personal persona data, credentials, or private project activity here.
- Keep instance-specific persona state under `local/workspace/personas/` (ignored by Git).
- Client persona paths remain thin compatibility wrappers; authority stays in Rust core/client runtime lanes.
