# HANDOFF — Spine/Security/Eyes + Next ROI (Contract + Routing)
TS: 2026-02-17 (America/Denver)
OWNER: Jacob (jay)
ASSISTANTS: Protheus (kimi-k2.5:cloud master), Codex candidate (for cleanup/contract)

## 0) Executive Summary
We built a deterministic “nervous system” skeleton:
- **External Eyes → Proposals → Queue → Outcomes → Eye scoring (EMA + yield) → Evolution**
- **Spine orchestration** sequences the above deterministically.
- **Guard security gate** enforces clearance tiers: state < habits < systems.

Next high ROI work:
1) Fix **CLI/help contract drift** so `contract_check.js` passes.
2) Wire/solidify **model routing** (local probes + banlist) carefully (optional, controlled).
3) Keep **stub sources** (X trends, Moltbook stubs) from clogging queue (queue_gc exists).

## 1) Current Architecture Map (Canonical Paths)
Repo root: ~/.openclaw/workspace

### Infrastructure (tier 3 / “harder to change”)
- systems/security/guard.js
  - deterministic clearance gate (machine-readable JSON to stdout; human stderr)
  - break_glass logs: state/security/break_glass.jsonl
- systems/spine/spine.js
  - orchestration only (plumbing)
  - ledger: state/spine/runs/YYYY-MM-DD.jsonl (spine_run_started/spine_run_ok)

### Habits (tier 2 / “easy to change reflex layer”)
- habits/scripts/external_eyes.js
  - run/score/evolve/list/propose
  - eyes config: config/external_eyes.json
  - state:
    - state/sensory/eyes/raw/YYYY-MM-DD.jsonl
    - state/sensory/eyes/metrics/YYYY-MM-DD.json
    - state/sensory/eyes/registry.json
- habits/scripts/eyes_insight.js
  - merges eyes raw → proposals JSON
  - IMPORTANT: uses item.eye_id (fixed) not item.source
  - evidence fields are now split:
    - evidence_ref: "eye:<id>" (machine parseable)
    - evidence_url, evidence_item_hash
    - title changes do not break ID stability
- habits/scripts/sensory_queue.js
  - ingest/list etc for proposals → queue
- habits/scripts/proposal_queue.js
  - source-of-truth for proposal status/outcomes
- habits/scripts/git_outcomes.js
  - scans git commits for tags (eye:<id>, proposal:<ID>) and records outcomes automatically
- habits/scripts/queue_gc.js
  - deterministic backlog control:
    - TTL reject: low-impact proposals older than 48h
    - cap per eye: keep 10 newest OPEN per eye, reject rest

### Routing config (exists)
- config/agent_routing_rules.json
  - contains: spawn_model_allowlist, slot_selection, handoff_packet, intent_to_risk_overrides
  - grep proof (user ran):
    - config/agent_routing_rules.json: spawn_model_allowlist, intent_to_risk_overrides, slot_selection, handoff_packet

## 2) What Was Shipped (Known Commits)
### Spine + guard architecture
- commit(s): 43316a0, f7f612e, 4cbce6b, 9dd6443 (sequence)
  - guard: machine-readable JSON, bounded approval note, break-glass audit
  - spine: orchestration + ledger in state/spine/runs/

### Eyes attribution + yield-aware scoring
- external_eyes.js updated to include:
  - outcome signals (proposal_queue outcomes)
  - yield signals (proposed vs shipped)
  - backlog throttling
  - cadence evolution rules now also consider yield/backlog
- commit mentioned by Protheus: 85a941f ("outcome-weighted scoring with yield signals")

### HN eye collector
- reverted to RSS collector:
  - config/external_eyes.json uses parser_type "hn_rss"
  - allowed_domains include news.ycombinator.com and hnrss.org
- commit mentioned: b3fc070

## 3) Current Known Issues / Risks
### A) Contract drift (ACTIVE ISSUE)
Codex reported:
- `contract_check.js` fails because it expects `--help` for some scripts,
  but external_eyes.js and sensory_queue.js do not conform.
Action: standardize CLI help contract across scripts validated by contract_check.

### B) “Tool not found” confusion (Not repo issue)
Protheus earlier hit “Tool not found” in its environment; user’s actual terminal works fine.
Don’t chase this in repo; treat as agent execution environment mismatch.

### C) Stub data still present
X trends and Moltbook items are often "[STUB]" placeholders.
Queue can grow; queue_gc exists but is new and should be monitored.

### D) Routing system not fully integrated yet
A proposed file `systems/routing/model_router.js` and habit `habits/scripts/route_probe.js`
were drafted but NOT reliably applied due to Protheus tool issues.
We should implement only if:
- we can safely read config/agent_routing_rules.json
- and we keep it deterministic, local-only probing, no cloud probing via `ollama run`.

## 4) The Exact Behavior We Want Next (Codex Task Scope)
### Goal 1: Make contract_check pass (highest ROI)
Requirements:
- For each script checked by contract_check, ensure:
  - `--help` prints usage and exits 0 (preferred)
  - AND/OR no-arg prints usage and exits 0
- Must NOT change runtime behavior of existing commands.
- Keep output deterministic.

Scripts likely affected:
- habits/scripts/external_eyes.js
- habits/scripts/sensory_queue.js
- habits/scripts/eyes_insight.js (if checked)
- systems/spine/spine.js (if checked)
- systems/security/guard.js (if checked)

### Goal 2: Repo noise policy (secondary, cautious)
Add/adjust ignore rules (likely .gitignore) for generated artifacts/state.
Constraints:
- Do NOT ignore source code / config / governance docs.
- Do NOT remove or untrack logs automatically; if proposing changes, document them.
- Keep audit trails available. If uncertain, only propose in README.

### Goal 3: Root README architecture map (secondary)
Add a short root README with:
- directory map
- how to run spine eyes/daily
- clearance tiers

### Out of scope for Codex without explicit approval
- Moving folders (especially memory/) or renaming canonical directories
- Modifying spine/guard behavior (except help-contract output formatting if needed)
- Changing scoring/evolution logic
- Implementing HTML scraping for HN (RSS is intentional)

## 5) How to Run / Smoke Tests
### Run eyes pipeline (spine)
cd ~/.openclaw/workspace
node systems/spine/spine.js eyes 2026-02-17 --max-eyes=1

Expected:
- guard JSON line to stdout: {"ok":true,...}
- eyes run/score/evolve
- eyes_insight merge
- sensory_queue list

### Check external eyes scoring artifacts
state/sensory/eyes/metrics/2026-02-17.json
state/sensory/eyes/registry.json

### Queue GC
node habits/scripts/queue_gc.js --date=2026-02-17 (if CLI exists)
or run spine daily mode once wired.

## 6) Proposed Optional Routing Upgrade (Do NOT implement unless asked)
If implementing model router:
- Create: systems/routing/model_router.js
- Create: habits/scripts/route_probe.js
Rules:
- Read candidates from config/agent_routing_rules.json spawn_model_allowlist
- Probe ONLY local Ollama models:
  - modelId startsWith "ollama/" AND does NOT include ":cloud"
- Probe prompt: `Return exactly: OK`
- If generic_hits >= 2 AND follows_instructions !== true, auto-ban 6h
- Log to: state/routing/routing_decisions.jsonl
Write caches:
- state/routing/model_health.json
- state/routing/banned_models.json

## 7) Rollback Plan
All changes should be isolated:
- contract/help fixes: revert single commit if needed
- ignore rules: revert .gitignore commit
- README: revert doc commit
No migrations.

## 8) Notes on Clearances (Guard)
- habits/ is tier 2 (default)
- systems/ and config/ are tier 3
- protected_files list (tier 4) currently empty
- BREAK_GLASS requires APPROVAL_NOTE and logs audit

END.
