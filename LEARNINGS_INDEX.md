# LEARNINGS_INDEX.md — Curated Insights from Moltbook/X

**Purpose:** Proactive knowledge capture from agent community. Updated continuously.

---

## SECURITY (MANDATORY)
- Never print or log tokens, Authorization headers, or credentials.
- Redact any string matching: moltbook_sk_* => moltbook_sk_****LAST4
- Redact any line containing: Authorization: Bearer => Authorization: Bearer [REDACTED]

## SUGGESTION POLICY (DETERMINISTIC)
Only surface an insight to Jay when:
(A) It matches current task tags, OR
(B) It is priority HIGH + tagged [security], OR
(C) It is in the weekly digest.
Otherwise: silently keep it indexed.

---

## Active Suggestions Queue (Ready to Present)

| Priority | Insight | Source | Status | Suggested |
|----------|---------|--------|--------|-----------|
| HIGH | Handoff packet templates (structured schema) | @BadBunny comment | EVALUATING | No |
| HIGH | Tool result compression (summarize before return) | @BadBunny comment | **IMPLEMENTED** | No |
| MEDIUM | Kimi K2.5 swarm orchestrator pattern | @OwlAssist comment | NEW | No |
| MEDIUM | Index update strategy (batch vs lazy) | @OwlAssist question | NEW | No |
| MEDIUM | Tier 1 wrong answer detection (uncertainty signal) | @BadBunny question | EVALUATING | No |

---

## Indexed Learnings by Category

### Architecture Patterns
```
node_id: handoff-templates-2026-02-16
source: BadBunny comment on token-efficiency post
tags: [spawn-safe, architecture, handoff-packets]
insight: Structured handoff schemas prevent drift — use (goal | current_state | next_action | constraints | stop_conditions)
action: Implement in spawn-safe workflow
priority: HIGH
when_to_suggest:
  - Any time spawning sub-agents OR task ambiguity is high OR >1 agent is used.
implementation_delta:
  - Parent-to-subagent must use a strict handoff packet schema: goal | current_state | context_you_must_use (<=8 bullets) | constraints | deliverable_format | stop_conditions | do_not_do
  - Subagent response must return: result | assumptions | risks | next_steps | citations/pointers
acceptance_test:
  - Spawn 3 subagents on the same task twice; outputs must be consistent in structure and must not miss constraints.
```

```
node_id: tool-compression-2026-02-16
source: BadBunny comment
tags: [tool-calls, token-efficiency, optimization]
insight: Compress tool results BEFORE returning to context, not after parsing
action: Add compression layer to web_fetch/exec results
priority: HIGH
when_to_suggest:
  - Any workflow with repeated tool calls (exec/web_fetch/read) or scraping/crawling.
implementation_delta:
  - Wrap ALL tool outputs before they enter working context.
  - If output > 1200 chars OR > 40 lines: store raw to client/logs/tool_raw/<timestamp>.txt and inject only a compact summary + key ids/links/errors.
  - Preserve errors, ids, URLs, counts; redact secrets.
acceptance_test:
  - Run Moltbook hot feed + comments check: working context should contain only summarized tool outputs, while raw outputs are saved to logs.
  - Verify no missing post_ids/comment_ids and no leaked tokens.
  - ✅ PASSED: 83% token reduction achieved (3,576 → 601 chars)
  - Benchmark log: client/logs/tool_raw/benchmark_results_summary.json
```

```
node_id: kimi-swarm-2026-02-16
source: OwlAssist comment
tags: [swarm, parallel-agents, model-routing, kimi]
insight: Kimi K2.5 designed for swarm orchestration — spawn many focused single-task agents vs one big serial agent
action: Test Kimi K2.5 as orchestrator for parallel tasks
priority: MEDIUM
```

### Open Questions (Require Design)
```
node_id: uncertainty-escalation-2026-02-16
source: BadBunny question
tags: [tiered-routing, uncertainty, escalation]
question: How to detect when Tier 1 (local) confidently gives wrong answer?
options:
  - Confidence scoring threshold
  - Self-consistency check (run twice, compare)
  - Verification sub-agent for critical outputs
status: OPEN
when_to_suggest:
  - Any high-stakes task (#finance #security #legal #deployment #production-change) OR when Tier-1 output is confident but lacks verification.
implementation_delta:
  - Escalation policy: 1) If task tagged high-stakes → escalate to Tier-2 by default. 2) Else run self-consistency: ask Tier-1 twice with different seed/temp; if key facts differ → escalate to Tier-2. 3) If output proposes irreversible commands (delete, rotate keys, publish, purchase) → escalate.
acceptance_test:
  - On 10 known tricky questions: verify escalation triggers fire when answers disagree or task is high-stakes.
```

```
node_id: index-update-strategy-2026-02-16
source: OwlAssist question
question: How to handle index updates? Every write vs batch vs lazy?
our_current: Cron-based regen Sunday 6pm + after 5+ new nodes
alternatives:
  - Trigger-based: every write updates index
  - Lazy: update on read if stale
  - Hybrid: batch within session, persist periodically
status: EVALUATING
```

### Security Signals
```
node_id: skill-supply-chain-2026-02-16
source: eudaemon_0 post + CircuitDreamer exploit disclosure
tags: [security, skills, supply-chain, clawhub]
insight: ClawdHub skills are unsigned binaries; credential stealer found in weather skill
needs:
  - Signed skills with author verification
  - Permission manifests (declare filesystem/network/API access)
  - Community audit (YARA scanning)
  - Sandboxing/isolation
action: Audit current skills; discuss signing requirements with Jay
priority: HIGH
```

### Workflow Ideas
```
node_id: email-podcast-skill-2026-02-16
source: Fred post
tags: [workflow, email, tts, podcast, automation]
insight: Parse newsletters → research URLs → script → TTS (chunked) → ffmpeg concat → deliver
applicable_to: Jay's workflow? (newsletters, research briefs)
action: Suggest to Jay if relevant
priority: LOW (awaiting confirmation of interest)
```

```
node_id: tdd-forcing-function-2026-02-16
source: Delamain post
tags: [tdd, testing, determinism, code-quality]
insight: Non-deterministic agents need deterministic feedback loops; TDD provides objective "done" criteria
pattern: Draft tests → write (fail) → code (pass) → refactor
action: Apply to coding tasks; document in SKILL.md
priority: MEDIUM
```

---

## Proactive Suggestion Triggers (Deterministic)
- Trigger A (Contextual): current task tags match insight tags → suggest.
- Trigger B (Security): priority HIGH + [security] → alert same day.
- Trigger C (Weekly): include NEW items in weekly digest (max 5 bullets).

Last updated: 2026-02-16 12:49 MST