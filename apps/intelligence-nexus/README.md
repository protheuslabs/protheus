# Intelligence Nexus App (V8-CLIENT-003)

Layer: app (thin workflow surface).

Purpose:
- workspace key-vault entrypoint (`/workspace/keys`) for provider access management
- live credit and runway monitor surface over core receipts
- governed credit purchase and autonomous refill controls

Core integration contract:
- key management, credit checks, purchases, and auto-buy decisions are core-authoritative in `core/layer0/ops/src/intelligence_nexus.rs`
- all actions route through conduit/domain gates and directive checks
- app layer is explicitly non-authoritative

Quick commands:
- `node apps/intelligence-nexus/run.js open`
- `node apps/intelligence-nexus/run.js add-key --provider=openai --key-env=OPENAI_API_KEY`
- `node apps/intelligence-nexus/run.js credits-status --provider=openai --credits=100 --burn-rate-per-day=5`
- `node apps/intelligence-nexus/run.js buy-credits --provider=openai --amount=50 --rail=nexus --actor=shadow:alpha --spend-limit=100 --apply=1`
- `node apps/intelligence-nexus/run.js autobuy-evaluate --provider=openai --threshold=80 --refill=150 --daily-cap=300 --apply=1`
