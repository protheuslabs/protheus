# Habit Layer Governance: Airtight Rules (v1)

**Effective:** 2026-02-14  
**Version:** 1.0  
**Status:** ENFORCED

---

## 0) Non-Negotiables

### Opt-In Crystallization
- Habits are **deliberately designed**, not emergent
- A habit only becomes runnable after passing **ALL promotion gates** AND being **trusted (hash pinned)**
- No "shadow habits" — if it's not in `registry.json` + `trusted_habits.json`, it doesn't exist

### Add-Verify-Swap Rule (Mandatory)
- **No habit can delete/disable/replace anything** unless a successor is verified working first
- Procedure: `ADD → VERIFY → SWAP → (then) REMOVE_OLD`
- Violation = automatic demotion + cooldown

### Idempotency by Default
- Re-running must not create duplicates, spam logs, or fork state
- All write operations must be upsert-style or checksum-guarded
- Logging must include `inputs_hash` to detect duplicate runs

---

## 1) When to PROPOSE a Habit (Candidate Detection)

A candidate can be proposed if **ANY** condition is met:

### A. Repetition Threshold
- Same task pattern executed **≥ 3 times in 14 days**
- AND tokens_est ≥ 500 per run (or equivalent complexity)

### B. Token Threshold
- tokens_est ≥ 2000 even if repeats < 3 (heavy workflows)

### C. High-Friction Threshold
- Any task that has **failed ≥ 2 times** due to:
  - Brittle syntax errors
  - Strict schema violations
  - Rate limiting
  - Cron failures, publish pipeline breaks, permission-gated tool failures

### Proposal Output Requirements (ALL mandatory)
```javascript
{
  slug: "unique_id",
  description: "What this does and why",
  inputs_schema: { /* JSON Schema */ },
  expected_outputs: { status, summary, side_effects[] },
  permissions_needed: {
    network: "deny" | "allow",
    write_paths_allowlist: [],
    exec_allowlist: []
  },
  rollback_plan: "How to revert if it breaks",
  test_plan: "2 representative test cases",
  estimated_savings: 1500, // tokens saved per run
  proposal_triggers: { which threshold(s) met }
}
```

---

## 2) When to PROMOTE (Create + Trust) a Habit

**ALL 4 gates must pass. ANY failure = remain candidate.**

### Gate 1 — Spec Completeness
Must define:
- ✅ Inputs schema (JSON Schema, `type: "object"` required)
- ✅ Output contract (what it returns/logs)
- ✅ Explicit allowed side effects (exact file paths, exec commands)
- ✅ `"network": "deny"` default unless explicitly justified
- ✅ Rollback plan (how to revert if it breaks)

### Gate 2 — Sandbox Test
- Run routine **2 times** with representative inputs
- Must succeed both times
- Must not write outside allowlist
- Must not require network if `network: deny`
- Must produce stable output (same structure each time)

### Gate 3 — Trust Pinning
- Add routine file hash to `trusted_habits.json`
- Add infra scripts (runner/doctor/etc) to `trusted_skills.json` if modified
- **Hash mismatch later → automatic block until re-approved**

### Gate 4 — Doctor Clean
```bash
node client/habits/scripts/doctor.js
```
Must pass with **0 errors** after promotion.

---

## 3) When to RUN a Habit vs. Do It Manually

### USE the Habit When:
- ✅ Task matches a registered habit ID
- ✅ Inputs match schema (validated)
- ✅ Required permissions already granted
- ✅ Repeatable workflow (maintenance, scheduled ops, validations, publish flows)

### Do It MANUALLY (No Habit) When:
- 🚫 Task is exploratory debugging
- 🚫 Requirements are unclear
- 🚫 Action changes external state in unseen way (new publish targets, new integrations)
- 🚫 One-off creative artifact where "token savings" would degrade quality
- 🚫 "This feels risky" — trust the feeling

---

## 4) When to REMOVE (GC) a Habit

**Garbage collection allowed ONLY when ALL true:**

| Check | Rule |
|-------|------|
| Inactivity | Last used ≥ 30 days ago (`last_used_at`) |
| Low usage | `uses_30d < 1` |
| Not protected | `pinned !== true` |
| No dependents | **NO cron job references the habit ID** (must search `cron list`) |

### Removal Procedure (Strict Order)
1. Move routine file to `client/habits/_archive/<id>.<date>.js`
2. Mark registry `status: archived`
3. Keep trusted hash record, add `"status": "archived"`
4. Log to `client/habits/client/logs/gc.ndjson`:
   ```json
   { "ts": "...", "habit_id": "...", "reason": "inactive 30d + uses<1 + no dependents", "archived_to": "..." }
   ```

---

## 5) The "Add → Verify → Swap" Rule

**Applies to:** crons, habits, any replaceable component

### Procedure
```
Step 1: ADD new thing
  → cron: openclaw cron add ...
  → habit: create + trust + registry update

Step 2: VERIFY
  → cron: openclaw cron list (confirm ID appears, check nextRunAtMs)
  → habit: run_habit --list (shows it) + doctor.js passes + run once

Step 3: Only then REMOVE old
  → cron: openclaw cron remove ...
  → habit: mark archived

Step 4: FINAL verification
  → Confirm old gone, new present
```

### Failure Handling
- If Step 1 or 2 fails → **DO NOT remove old**
- Exit with error + report
- This prevents "empty handed" failures

### Safe-Cron-Swap Habit
Use `safe_cron_swap.js` for atomic cron replacement:
- Writes before/after snapshots
- Verifies at each step
- Automatic rollback on failure

---

## 6) Safety Boundaries (Prevents Downside)

### Default Permissions
| Aspect | Default | Override Requires Justification |
|--------|---------|----------------------------------|
| Network | `"deny"` | Must document why needed |
| Write paths | Explicit only | No broad globs beyond `client/memory/*.md`, `client/habits/client/logs/*`, `client/habits/registry.json` |
| Exec | Exact commands | Never `"node *"` — must specify script path |

### Posting/Publishing Habits (Extra Guardrails)
Any habit that touches posting/publishing must:
1. Include `dry_run` input option if feasible
2. Log final payload content to memory before/after action
3. Include confirmation step for external-facing actions

**Note:** AI-to-AI mediums (Moltbook) are acceptable; these rules protect from accidental spam or wrong targets.

### Blocked Operations (Always)
- No habit can modify `trusted_skills.json` or `trusted_habits.json` directly
- No habit can delete files outside its allowlist
- No habit can spawn new processes outside exec_allowlist
- No habit can access network if `network: deny`

---

## 7) Metrics (Prove It's Working)

### Per-Run Logging
Each habit run logs to `client/habits/client/logs/habit_runs.ndjson`:
```json
{
  "ts": "ISO-8601",
  "habit_id": "...",
  "duration_ms": 123,
  "status": "success" | "error",
  "estimated_tokens_saved": 1500,
  "side_effects": ["file:path", "exec:command"],
  "inputs_hash": "sha256_of_normalized_inputs"
}
```

### Weekly Report (Automated)
Output to `client/memory/{date}.md`:
```markdown
## Weekly Habit Metrics

### Top 3 by Estimated Savings
| Habit | Runs | Tokens Saved |
|-------|------|--------------|
| ... | ... | ... |

### Top 3 by Failure Rate
| Habit | Runs | Errors | Rate |
|-------|------|--------|------|
| ... | ... | ... | ... |

### Governance Events
- Promoted: [list]
- Demoted: [list]
- Archived: [list]
```

---

## Enforcement

### Doctor Checks
```bash
node client/habits/scripts/doctor.js
```
Validates:
- ✅ All habits have complete spec (schema, permissions, rollback)
- ✅ All active habits have trust pins
- ✅ No orphaned trust pins (habit archived but pin active)
- ✅ GC candidates have no cron dependents
- ✅ Add-Verify-Swap rule followed in recent ops

### Automatic Consequences
| Violation | Action |
|-----------|--------|
| Hash mismatch | Block execution, require re-trust |
| Permission denied | Log error, increment consecutive_errors |
| consecutive_errors ≥ 2 | Demote to disabled + 24h cooldown |
| Add-Verify-Swap violation | Prevent operation, report to user |
| Network access with deny | Block + log security event |

---

## Amendment Procedure

This document is append-only with versioning:
1. Propose change via PR/issue
2. Update version number in header
3. Add changelog section
4. Re-run doctor.js to validate compliance
5. User approval required for v1.0+

---

*"Airtight means no leaks. Verify everything, trust nothing that hasn't been proven."*
