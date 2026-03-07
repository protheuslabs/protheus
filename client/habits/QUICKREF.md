# Habit Governance Quick Reference

**Version:** 1.0 | **Status:** ENFORCED | **Last Updated:** 2026-02-14

---

## Crystallization Triggers (PROPOSE)

| Trigger | Threshold | Qualifies? |
|---------|-----------|------------|
| **A - Repetition** | ≥3 times in 14d AND tokens ≥500 | ANY |
| **B - Cost** | ≥2,000 tokens (heavy workflows) | ANY |
| **C - Friction** | ≥2 failures in 30d (syntax/schema/rate-limit) | ANY |

**Rule:** ANY single trigger qualifies for `candidate` proposal.

---

## Promotion Gates (candidate → active)

| Gate | Check | Command |
|------|-------|---------|
| **1 - Spec** | Schema + rollback + test plan | `propose_habit.js` |
| **2 - Sandbox** | 2 successful test runs | Manual execution |
| **3 - Trust** | SHA-256 pinned | `trust_add_habit.js` |
| **4 - Doctor** | 0 errors | `doctor.js` |

**Rule:** ALL gates must pass.

---

## Demotion Triggers (active → disabled)

| Trigger | Threshold | Cooldown |
|---------|-----------|----------|
| Consecutive errors | ≥2 | 24h |
| Low outcome score | avg 5-run ≤0.40 | 24h |
| Permission violation | ANY | 24h |
| Hash mismatch | detected | 24h |

---

## Archive Rules (candidate/disabled only)

**NEVER auto-archive active habits.**

| Check | Rule |
|-------|------|
| State | candidate OR disabled |
| Inactivity | >30 days |
| Usage | <1 uses_30d |
| Pinned | false |
| Cron ref | none |

---

## Add → Verify → Swap Rule

```bash
# 1. ADD
 node client/habits/scripts/propose_habit.js ...
 node client/habits/scripts/trust_add_habit.js ...

# 2. VERIFY
 node client/habits/scripts/run_habit.js --id NEW --json '{}'
 node client/habits/scripts/doctor.js  # must pass

# 3. SWAP (only then remove old)
# For crons: safe_cron_swap.js does this atomically
```

**Failure mode:** Report error, DO NOT remove old.

---

## Default Permissions

```json
{
  "network": "deny",
  "write_paths_allowlist": ["client/memory/*.md", "client/habits/client/logs/*"],
  "exec_allowlist": ["explicit/command/here"]
}
```

---

## CLI Reference

```bash
# Propose (Trigger A: repeats>=3 + tokens>=500)
node client/habits/scripts/propose_habit.js --from "desc" --repeats_14d 4 --tokens_est 600

# Propose (Trigger B: tokens>=2000)
node client/habits/scripts/propose_habit.js --from "desc" --tokens_est 2500

# Propose (Trigger C: errors>=2)
node client/habits/scripts/propose_habit.js --from "desc" --errors_30d 3

# List
node client/habits/scripts/run_habit.js --list

# Run
node client/habits/scripts/run_habit.js --id HABIT_ID --json '{}'

# Doctor (validation)
node client/habits/scripts/doctor.js

# GC (garbage collection)
node client/habits/scripts/habit_gc.js --dry-run
node client/habits/scripts/habit_gc.js --apply
```

---

## When to RUN vs MANUAL

| RUN | MANUAL |
|-----|--------|
| Repeatable workflow | Exploratory debugging |
| Schema-validated inputs | Requirements unclear |
| Permissions granted | New external state |
| Maintenance/scheduling | Creative/one-off artifact |

---

## State Summary

| Habit | State | Trust | Status |
|-------|-------|-------|--------|
| `rebuild_validate_memory` | active | ✅ | Ready |
| `safe_cron_swap` | candidate | ✅ | Needs 3 successes |

---

*"Airtight means no leaks. Verify everything."*
