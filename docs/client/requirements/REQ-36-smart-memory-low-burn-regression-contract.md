# REQ-36 — Smart Memory Low-Burn Regression Contract

Status: proposed  
Owner: Runtime + Memory  
Updated: 2026-03-09

## Objective

Enforce the smart-memory architecture so memory reads/queries stay low-burn by default and regressions are fail-closed:

- index-first lookup,
- node-only reads,
- dynamic lazy hydration,
- strict context budgets,
- matrix-ranked recall,
- deterministic telemetry and SLO gates.

## Scope

- Startup identity hydration policy.
- Memory traversal/read contracts.
- Memory recall budget defaults and enforcement.
- Matrix/sequencer/auto-recall ranking invariants.
- CI regression gates for token burn.

## Non-Goals

- No removal of narrative/manual full-read tools for explicit operator workflows.
- No replacement of the existing memory matrix architecture.
- No change to core conduit authority boundaries.

## Functional Requirements

### REQ-36-001 Index-first traversal contract
- Memory retrieval must follow: `TAGS_INDEX.md` -> `MEMORY_INDEX.md` -> specific node section.
- Daily files must not be scanned wholesale in default query mode.

### REQ-36-002 Node-only read enforcement
- Default memory query/read paths must load only matched node sections.
- Full daily-file reads are blocked unless one of:
  - explicit operator override,
  - narrative mode,
  - index rebuild/maintenance lane.

### REQ-36-003 Lean startup hydration
- Default startup hydration must be bounded and minimal (`SOUL.md`, `USER.md` only).
- `MEMORY.md`, `MEMORY_INDEX.md`, and `TAGS_INDEX.md` must remain lazy by default.

### REQ-36-004 Dynamic memory hydration
- Memory context should hydrate on demand when retrieval actually needs it.
- Hydration snapshots must persist loaded/deferred file lists and estimated token load.

### REQ-36-005 Recall budget defaults
- Memory recall defaults must remain low-burn:
  - small `top` result count,
  - low excerpt line count,
  - default `expand=none`,
  - strict default context budget.

### REQ-36-006 Hard context-budget gate
- Query output must enforce context budget with deterministic `trim|reject` behavior.
- Receipts must include `tokens_est_before`, `tokens_est_after`, and cap/trim/drop stats.

### REQ-36-007 Low-burn SLO gate
- Add executable SLO checks for standard recall flows with a target under 200 tokens/query (estimated tokens after budget enforcement).
- CI/runtime gate must fail on sustained regression beyond threshold.

### REQ-36-008 Matrix/sequencer ranking invariants
- Memory matrix ranking must preserve weighted score inputs:
  - memory level (`node1 > tag2 > jot3`),
  - recency,
  - dream inclusion.
- Dream sequencer must periodically reorder ranked entries with deterministic receipts.

### REQ-36-009 Auto-recall bounded behavior
- Auto-recall must compute top relevant matches from matrix/tag overlap and push bounded results into attention queue.
- Auto-recall must not trigger full-file reads in normal operation.

### REQ-36-010 Index freshness and stale-read guard
- Index freshness must be enforced (scheduled rebuild and post-write thresholds).
- Retrieval path must emit stale-index warnings/failures when freshness contracts are violated.

### REQ-36-011 LensMap memory annotation contract (future-safe)
- Add optional lens metadata contract for tags/nodes/jots in lens/comment docs so retrieval can stay indexable without touching code content.
- This must remain comment/docs-layer only and not mutate execution logic.

## Safety Requirements

1. Never bypass conduit boundary for memory operations.
2. Full-file read exceptions must be explicit, auditable, and bounded.
3. Token budget enforcement must fail closed in strict mode.
4. Regression gates must prevent silent expansion of startup/query token burn.

## Acceptance Criteria

1. Startup hydration receipts show minimal loaded files and deferred memory files by default.
2. Standard memory queries remain under the configured low-burn threshold with receipts.
3. Full-file read attempts in default mode are denied or rerouted with explicit reason codes.
4. Matrix/sequencer and auto-recall outputs remain deterministic and bounded.
5. CI gate catches stale paths or budget regressions before merge.
