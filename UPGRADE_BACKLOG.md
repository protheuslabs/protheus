# Upgrade Backlog

Purpose: track future upgrades without mixing them into active implementation threads.

Status legend:
- `todo` not started
- `doing` actively in progress
- `blocked` waiting on dependency/decision
- `done` completed

## P0

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-001 | done | External temp-data backup pipeline (outside git) | Preserve high-churn runtime/state data without repo noise | `systems/ops/state_backup.js` + `config/state_backup_policy.json`, optional daily spine hook (`STATE_BACKUP_ENABLED=1`), retention policy encoded |
| BL-002 | todo | Skill quarantine enforcement in all install paths | Prevent unreviewed skill install bypasses | All skill installs routed through `install_skill_safe.js` or equivalent gate |
| BL-003 | done | Autonomy receipt dashboard/summary | Make pass/fail verification visible without raw log digging | Daily summary command/report shows receipt pass rate + top failure reasons |
| BL-013 | todo | AGI security/governance hardening pack | Prevent capability-overhang failures as model capability increases | Dual-control approval for strategy mode escalation + non-bypass budget/risk caps + immutable policy/kernel verification + one-command emergency stop path tested |

## P1

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-004 | todo | Policy for tracked vs ignored state streams | Keep audit logs intentional and reduce accidental tracking drift | One doc defines tracked state classes and `.gitignore` alignment |
| BL-005 | todo | Habit promotion quality hardening | Prevent no-op scaffolds from promoting without real value | Promotion checks include measured savings/effect threshold |
| BL-006 | todo | Automated stale-state cleanup helper | Reduce local churn from old generated artifacts | Non-destructive cleanup command with dry-run and allowlist |
| BL-009 | todo | Hardware-aware local model planner | Keep local routing aligned with actual machine capacity | Router can detect CPU/RAM/VRAM class, recommend/update eligible local models, and log changes before activation |
| BL-010 | todo | Model variant profiles (`:thinking` and base) | Use reasoning variants only when justified to control cost/latency | Routing policy defines when to use thinking variants, with auto-return to anchor model and measurable quality gain |
| BL-011 | todo | Swarm verification mode for deep-thinker | Multi-agent cross-check for high-stakes reasoning once swarm capability exists | Deep-thinker can run parallel model checks with quorum/consensus policy and bounded token budget |
| BL-012 | done | Strategy profile layer + architecture genericity guard | Keep specialization out of `systems/` while enabling adaptive policy | `config/strategies/` active profile loaded by autonomy gates; architecture guard available in audit/strict modes; initial rollout uses `execution_policy.mode=score_only` |
| BL-014 | todo | Phased TypeScript migration for `systems/` + `lib/` | Reduce contract drift and runtime breakage in high-permanence layers without rewriting architecture | `tsconfig` added; `systems/` + `lib/` run type-check clean in CI (`--noEmit`); migration done file-by-file with compatibility wrappers and zero behavior regressions |

## P2

| ID | Status | Upgrade | Why | Exit Criteria |
|---|---|---|---|---|
| BL-007 | todo | Backup integrity checks | Catch silent backup corruption | Scheduled hash verification and alert on mismatch |
| BL-008 | todo | Repo hygiene CI check for generated artifacts | Prevent noisy files slipping into PRs | CI fails if generated paths are staged unexpectedly |

## Notes

- Keep this file focused on upgrades (not daily tasks).
- Prefer adding one line per upgrade with concrete exit criteria.
- When an item starts, switch `Status` to `doing` and link the implementation commit(s).
- Tier policy: keep 3 tiers by default; add extra tiers only if telemetry shows persistent misrouting or cost/latency pressure that role-specialization cannot solve.
