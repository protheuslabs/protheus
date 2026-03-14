# Internal Docs Namespace

This namespace stores persona/internal artifacts that are not required for operator onboarding.

## Persona Contracts
- `docs/client/internal/persona/AGENT-CONSTITUTION.md`
- `docs/client/internal/persona/IDENTITY.md`
- `docs/client/internal/persona/SOUL.md`
- `docs/client/internal/persona/USER.md`
- `docs/client/internal/persona/MEMORY.md`
- `docs/client/internal/persona/CODEX_HELIX.md`

These internal persona aliases point at tracked blank templates under `docs/workspace/templates/assistant/`.
Live operator-specific copies belong under `local/workspace/assistant/`.

## Legacy/Internal Artifacts
- `docs/client/internal/legacy/moltbook_cron_job.json`
- `docs/client/internal/legacy/slack_status_cron_job.json`
- `docs/client/internal/legacy/moltstack.skill`

## Reminder Data Bridge
- `client/runtime/systems/ops/reminder_data_bridge.ts`
- Purpose: read-only readiness snapshots for reminder jobs (`slack-status`, `moltcheck-status`) so heartbeat reminders can degrade gracefully when required runtime data or credentials are unavailable.

Repository-root persona files are deprecated. Contracts now target tracked templates plus local instance copies.
