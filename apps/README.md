# Apps Surface

Top-level apps live in `/apps` and run on top of the client/runtime surfaces.

Rules:
- Apps are not part of `client/`.
- Core authority remains in `core/` and is accessed via conduit-aware wrappers.
- Apps may provide UX/workflow bundles, templates, and orchestration glue.

Default apps:
- `ad_factory/` — AI-powered video ad generation app scaffold.
- `creator_outreach/` — autonomous creator discovery + outreach app scaffold.
