# REQ-38: Agent Orchestration Hardening and Multi-Agent Audit Patterns

Version: 1.0
Date: 2026-03-15
Owner: Protheus Core / Cognition

## Objective

Harden multi-agent orchestration patterns to enable reliable parallel audits, coordinated task execution, and deterministic aggregation of sub-agent findings. Addresses gaps observed during SRS regression audits where parallel agents produced overlapping findings, timed out without recovery, and lacked standardized output formats.

## Scope

In scope:
- Coordinator agent pattern for partitioning work and deduplicating findings
- Shared state / scratchpad for cross-agent communication
- Checkpointing and timeout recovery mechanisms
- Strict scope boundaries to prevent overlap
- Standardized output schema for agent findings
- Completion triggers and task group metadata
- Partial result retrieval from timed-out agents

Out of scope:
- Replacing REQ-12 (Swarm Engine Router) — this extends it
- Replacing REQ-15 (Sandboxed Sub-Agent Execution) — this complements it
- Changing underlying spawn/session mechanics

## Related Requirements

- REQ-12: Swarm Engine Router (message routing, queue handoff)
- REQ-15: Sandboxed Sub-Agent Execution (isolated execution, scoped permissions)
- REQ-36: Smart Memory Low-Burn Regression Contract (shared state patterns)
- V6-SWARM-033 through V6-SWARM-038: spawned-agent tool manifests, hierarchical budgets, dead-letter recovery, restart recovery, the expanded dominance audit suite, and the generic-agent bootstrap contract for direct swarm bridge discovery

## Requirements

### REQ-38-001: Coordinator Agent Pattern

**Requirement:** Implement a coordinator agent that partitions work, deduplicates findings, and aggregates outputs from multiple sub-agents.

**Acceptance:**
- Coordinator accepts task description + list of subagent scopes
- Coordinator assigns non-overlapping work partitions to each sub-agent
- Coordinator receives findings from all sub-agents
- Coordinator deduplicates findings (same item_id reported by multiple agents)
- Coordinator merges severity ratings using highest-wins policy
- Coordinator emits unified report with consistent formatting

**Evidence:**
- Coordinator implementation in `client/cognition/orchestration/coordinator.ts`
- Test: `tests/client/cognition/coordinator.test.js` (partitioning, dedupe, severity merge)
- Test: `tests/client/cognition/orchestration.integration.test.js` (multi-agent integration)

---

### REQ-38-002: Shared State / Scratchpad

**Requirement:** Provide a shared workspace for cross-agent communication during multi-agent tasks.

**Acceptance:**
- Shared scratchpad file created at task start (`local/workspace/scratchpad/{task_id}.json`)
- Agents can read/write progress, findings, and checkpoints
- Scratchpad schema versioned for compatibility
- Scratchpad includes: items_checked[], findings[], progress_percent, last_updated
- Scratchpad is cleaned up after task completion (success or failure)

**Evidence:**
- Implementation in `client/cognition/orchestration/scratchpad.ts`
- Test: `tests/client/cognition/scratchpad.test.js` (read/write/schema/cleanup)

---

### REQ-38-003: Checkpointing and Timeout Recovery

**Requirement:** Agents must write progress to disk at intervals and support partial result retrieval on timeout.

**Acceptance:**
- Agents write checkpoint to scratchpad every 10 items or 2 minutes (whichever comes first)
- Checkpoint includes: last_item_id, findings_sofar[], timestamp
- On timeout, agent returns partial results + last checkpoint location
- Parent session can retrieve partial results via checkpoint path
- One automatic retry attempted before marking as failed

**Evidence:**
- Implementation in `client/cognition/orchestration/checkpoint.ts`
- Test: `tests/client/cognition/checkpoint.test.js` (10 items / 2min + timeout recovery)
- Test: `tests/client/cognition/partial.checkpoint.test.js` (checkpoint fallback retrieval)

---

### REQ-38-004: Strict Scope Boundaries

**Requirement:** Enforce domain scoping via explicit allowlists to prevent overlapping work assignments.

**Acceptance:**
- Scope format supports: `series:[V3-SEC,V4-SEC]` or `paths:[adapters/cognition/*]`
- Coordinator validates scope non-overlap before spawning
- Agents report out-of-scope findings separately (not as primary findings)
- Scope violations logged to coordinator for reassignment

**Evidence:**
- Implementation in `client/cognition/orchestration/scope.ts`
- Test: `tests/client/cognition/scope.validation.test.js` (valid scope formats)
- Test: `tests/client/cognition/scope.overlap.test.js` (overlap detection)
- Test: `tests/client/cognition/scope.violation.test.js` (violation logging)

---

### REQ-38-005: Standardized Output Schema

**Requirement:** All agents return findings in a consistent JSON structure.

**Acceptance:**
- Schema defined in `client/cognition/orchestration/schemas/finding-v1.json`
- Required fields: audit_id, item_id, severity, status, location, evidence, timestamp
- Severity enum: CRITICAL, HIGH, MEDIUM, LOW
- Status enum: missing, partial, drift, compliant
- Location format: "file:line" or "file:line:column"
- Schema validation enforced before accepting agent results

**Evidence:**
- Schema file: `client/cognition/orchestration/schemas/finding-v1.json`
- Test: `tests/client/cognition/schema.validation.test.js` (valid/invalid payloads)
- Test: `tests/client/cognition/schema.enforcement.test.js` (rejection of non-compliant)

---

### REQ-38-006: Completion Triggers

**Requirement:** Auto-notify parent session when all subagents in a task group complete.

**Acceptance:**
- Task group ID assigned at spawn time (`task_group: srs-audit-2026-03-15`)
- System tracks agent status: pending, running, done, failed, timeout
- When all agents report done/failed/timeout, parent session notified
- Notification includes: completed_count, failed_count, timeout_count, partial_count
- Optional: auto-aggregate results into unified report

**Evidence:**
- Implementation in `client/cognition/orchestration/completion.ts`
- Test: `tests/client/cognition/completion.tracking.test.js` (status tracking)
- Test: `tests/client/cognition/completion.notification.test.js` (parent notification)
- Test: `tests/client/cognition/completion.aggregate.test.js` (auto-aggregation)

---

### REQ-38-007: Task Group Metadata

**Requirement:** Tag subagents with task group ID for collective tracking and querying.

**Acceptance:**
- Task group ID format: `{task_type}-{timestamp}-{nonce}`
- All subagents in group tagged with group ID in session metadata
- API supports querying all agents by task group ID
- Task group metadata includes: created_at, coordinator_session, agent_count, status

**Evidence:**
- Implementation in `client/cognition/orchestration/taskgroup.ts`
- Test: `tests/client/cognition/taskgroup.tagging.test.js` (metadata tagging)
- Test: `tests/client/cognition/taskgroup.query.test.js` (group querying)
- Test: `tests/client/cognition/taskgroup.metadata.test.js` (metadata completeness)

---

### REQ-38-008: Partial Result Retrieval

**Requirement:** Ability to fetch partial results from timed-out or failed agents.

**Acceptance:**
- API: `sessions_history(sessionKey, includeTools=true)` returns partial results
- Fallback: Read checkpoint files from workspace if session unavailable
- Partial results include: items_completed, findings_sofar[], checkpoint_path
- Parent session can decide: retry, continue with partial, or abort

**Evidence:**
- Implementation in `client/cognition/orchestration/partial.ts`
- Test: `tests/client/cognition/partial.session.test.js` (session history retrieval)
- Test: `tests/client/cognition/partial.checkpoint.test.js` (checkpoint fallback)
- Test: `tests/client/cognition/partial.decision.test.js` (parent decision flow)

## Verification Requirements

- Unit tests for each REQ-38-00X component
- Integration test: Full multi-agent audit with coordinator, scratchpad, and completion triggers
- Load test: 20+ parallel agents with checkpointing and timeout recovery
- Invariant: No overlapping work assignments in partitioned tasks
- Invariant: All findings conform to standardized schema
- Swarm-runtime hardening must also preserve:
  - authoritative spawned-agent tool manifests (`sessions_send`/`sessions_query`/`sessions_state` exposed from spawn receipts, not inferred),
  - hierarchical token reservation/settlement across parent-child chains,
  - dead-letter + retry recovery under TTL expiry/backpressure,
  - persistent-session resume after runtime reload.

## Execution Notes

- Priority order: REQ-38-005 (schema) → REQ-38-002 (scratchpad) → REQ-38-006 (completion) → REQ-38-001 (coordinator) → REQ-38-003 (checkpointing) → REQ-38-004 (scope) → REQ-38-007 (task group) → REQ-38-008 (partial results)
- Start with schema and shared state — everything else builds on these
- Coordinator can be lightweight initially — focus on correct partitioning over sophisticated algorithms
- Checkpointing is critical for long-running audits (SRS regression took 4-6 minutes per agent)

## Amendment Notes

- REQ-15-002 (Dynamic sub-agent spawning) should reference REQ-38-007 for task group metadata
- REQ-12-008 (Swarm observability receipts) should reference REQ-38-005 for standardized finding schema
- REQ-36 (Smart Memory) scratchpad implementation may share patterns with REQ-38-002

## Companion Evidence Updates

### 2026-03-19: Swarm Runtime Companion Update

- Repair-lane execution now routes by contract runtime (`srs_contract_runtime` vs `runtime_systems`) to prevent stale path failures and ensure deterministic contract receipts for swarm-adjacent lanes.
- Ranked ROI lane execution was expanded and verified at 300-lane scale with deterministic lane-only execution controls.
- Current evidence references:
  - `core/layer0/ops/src/swarm_runtime.rs`
  - `tests/tooling/scripts/ci/srs_repair_lane_runner.mjs`
  - `tests/tooling/scripts/ci/roi100_moves_runner.mjs`
  - `core/layer0/ops/tests/v6_openfang_closure_integration.rs`
