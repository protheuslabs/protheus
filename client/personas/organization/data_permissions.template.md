# <Persona Name> Data Permissions

- feed: enabled=true scope=internal_master_feed notes=master_llm_persona_updates
- system_internal: {enabled: false, sources: [memory, loops, analytics]}
- slack: enabled=false scope=workspace_channel notes=requires_explicit_oauth_consent
- linkedin: enabled=false scope=inbox_messages notes=requires_explicit_oauth_consent

## Rules

- External sources remain disabled until explicit operator approval.
- Feed source is internal-only and may be used for offline persona refresh.
- `system_internal` can pass system-generated context (client/memory/loops/analytics) when enabled.
- All ingestion events must be auditable and appended to persona memory.

## Core 5 Default

For `vikram_menon`, `priya_venkatesh`, `rohan_kapoor`, `li_wei`, and `aarav_singh` set:

- system_internal: {enabled: true, sources: [memory, loops, analytics]}
