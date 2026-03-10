# Apps Surface

Top-level apps live in `/apps` and run on top of the client/runtime surfaces.

Rules:
- Apps are not part of `client/`.
- Core authority remains in `core/` and is accessed via public platform contracts.
- Apps may be polyglot.
- Apps may provide UX/workflow bundles, templates, orchestration glue, and product logic.
- Apps must not become the source of truth for policy, receipts, or system safety decisions.
- If an app mainly exists to connect InfRing to an external system, it should likely be an adapter instead of an app.

Default apps:
- `ad_factory/` — AI-powered video ad generation app scaffold.
- `creator_outreach/` — autonomous creator discovery + outreach app scaffold.
