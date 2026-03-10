# Adapters Surface

Top-level adapters live in `/adapters` and connect InfRing to external or legacy systems.

Rules:
- Adapters are not part of `client/` or `core/`.
- Adapters may be polyglot.
- Adapters should consume public platform contracts exposed by the client/platform surface.
- Adapters must not bypass conduit, policy, receipts, or core authority.
- If an adapter starts owning canonical policy, scheduling, receipts, or system truth, it is misplaced and should move into `core/`.

Examples:
- wrappers around third-party SaaS APIs
- bridges to legacy CLIs or desktop apps
- compatibility layers for external workflows not designed for InfRing
