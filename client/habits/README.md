# Habit Layer v1.5 — Neural Plasticity with Clear Triggers

Crystallized routines for token-saving, deterministic execution. Upgraded with state machine (candidate→active→disabled→archive) and promotion/demotion/cooldown.

## Quick Start

```bash
# List all habits with states
node client/habits/scripts/run_habit.js --list

# Run a habit (active habits; candidates require --force to auto-promote tracking)
node client/habits/scripts/run_habit.js --id rebuild_validate_memory --json '{"notes":"optional"}'

# Propose a new habit (requires BOTH triggers A AND B)
node client/habits/scripts/propose_habit.js \
  --from "Rebuild and validate memory" \
  --tokens_est 2500 \
  --repeats_14d 4 \
  --operations 8

# Garbage collection (preview)
node client/habits/scripts/habit_gc.js --dry-run
node client/habits/scripts/habit_gc.js --apply

# Check capacity
node client/habits/scripts/habit_gc.js --check-cap

# List habits with trust status
node client/habits/scripts/habit_list.js --trusted

# System health check
node client/habits/scripts/doctor.js
```

## Clear Triggers (When to Crystallize)

A habit is warranted when **BOTH** triggers are met:

### TRIGGER A — Repetition
- Same task intent occurs ≥3 times in 14 days **OR** ≥5 times in 30 days
- Intent key normalization: lowercase → remove dates/UUIDs/timestamps → collapse whitespace → keep top 12 keywords

### TRIGGER B — Cost (any one qualifies)
- Estimated tokens ≥1,500 per run, **OR**
- Manual steps ≥6 distinct operations, **OR**
- Has caused ≥1 production error/incident in last 30 days

### Proposal Output Requirements (Hard)
- `intent_key` — normalized intent
- `repeats_14d`, `repeats_30d`
- `exact_inputs_schema` — full JSON schema
- `exact_permissions` — network + write_paths_allowlist[] + exec_allowlist[]
- `entrypoint` — must be client/habits/routines/<id>.js
- `target_state` — always "candidate" (not active)

## Lifecycle States

```
         ┌─────────────┐
         │   none      │ ← Habit doesn't exist
         └──────┬──────┘
                │ propose (triggers A+B met)
                ▼
         ┌─────────────┐
         │  candidate  │ ← Unpromoted, awaiting trust + proof
         │  (target)   │    Runs tracked but won't auto-execute
         └──────┬──────┘
                │ promote (ALL must be true)
                │   • trusted (sha256 pinned)
                │   • ≥3 successful runs
                │   • avg outcome_score ≥0.70 (last 3 runs)
                │   • 0 permission violations (last 10 runs)
                │   • doctor.js passes
                ▼
         ┌─────────────┐
         │   active    │ ← Full citizen, can auto-execute
         │  (running)  │
         └──────┬──────┘
                │ demote (ANY trigger)
                │   • consecutiveErrors ≥2
                │   • avg outcome_score ≤0.40 (last 5 runs)
                │   • permission violation (PERMISSION_DENIED)
                │   • hash mismatch (supply-chain safety)
                │   • state destructive near-miss
                ▼
         ┌─────────────┐
         │  disabled   │ ← Cannot execute (cooldown enforced)
         │  (cooldown)   │    Use --force to override manually
         └──────┬──────┘
                │ archive (ALL must be true)
                │   • state is candidate OR disabled (NEVER active)
                │   • last_used_at > gc.inactive_days (30d)
                │   • uses_30d < gc.min_uses_30d (1)
                │   • pinned != true
                ▼
         ┌─────────────┐
         │  archived   │ ← Moved to _archive/, trust preserved
         │  (stored)   │
         └─────────────┘
```

## Promotion Rules

Candidate → Active requires ALL:
1. ✅ Trusted (SHA-256 pinned in `trusted_habits.json`)
2. ✅ ≥3 successful runs tracked
3. ✅ Avg outcome_score last 3 runs ≥0.70
4. ✅ Zero permission violations last 10 runs
5. ✅ doctor.js passes after last modification

## Demotion Rules

Active → Disabled when ANY trigger fires:
- ❌ consecutiveErrors ≥2
- ❌ outcome_score avg last 5 runs ≤0.40
- ❌ Permission violation detected
- ❌ Hash mismatch (security violation)
- ❌ State destructive near-miss

**Cooldown:** 1,440 minutes (24 hours) by default

## Archive Rules

Archive ONLY when ALL true:
1. ✅ State is **candidate** OR **disabled** (NEVER auto-archive active)
2. ✅ last_used_at > 30 days ago
3. ✅ uses_30d < 1
4. ✅ pinned != true

**Hard Cap:** If max_active=25 would be exceeded, GC evicts oldest eligible candidate via LRU before adding new.

## Trust Approval

Habits are security-gated like skills. Before running:

```bash
# For candidate habits (routines)
node client/habits/scripts/trust_add_habit.js \
  client/habits/routines/<habit>.js \
  "habit approval: description"

# Verify
node client/habits/scripts/habit_list.js --trusted
```

## Security

- **Network**: deny (default)
- **Write paths**: allowlist only
- **Exec**: allowlist only (explicit commands, no wildcards)
- **Hash verification**: SHA-256 pinned per-file
- **Hard fails**: HABIT_NOT_ALLOWLISTED, HABIT_NOT_TRUSTED, HABIT_HASH_MISMATCH
- **Break glass**: Configurable but disabled by default

## State Change Reporting

Every proposal, promotion, demotion, or archive writes a memory SNIP:

```yaml
<!-- SNIP: habit-state-{id}-{timestamp} -->
**Habit State Change: {habit_id}**
- Transition: {previous} → {new}
- Reason: {which trigger fired}
- Stats: uses_30d=X, errors=Y, score=Z
- Safety: {notes}
```

## Files

- `client/habits/registry.json` — State machine + metrics
- `client/habits/routines/` — Habit code (routines)
- `client/habits/routines/_archived/` — Archived routines
- `client/habits/scripts/` — Infrastructure (runner, doctor, GC, proposer)
- `client/habits/client/logs/habit_runs.ndjson` — Execution log with outcome_score/delta_value
- `client/habits/client/logs/habit_errors.ndjson` — Error log

## Schema Reference

See `client/habits/registry.json` for full schema:
- `version`: 1.5
- `max_active`: 25
- `gc.{inactive_days, min_uses_30d}`
- `habits[].{id, name, entrypoint, permissions, status, outcome, governance, metrics}`
