# Wu Jie Data Permissions

- feed: enabled=true scope=internal_master_feed notes=master_llm_persona_updates
- system_internal: {enabled: false, sources: [memory, loops, analytics]}
- slack: enabled=false scope=workspace_channel notes=requires_explicit_oauth_consent
- linkedin: enabled=false scope=inbox_messages notes=requires_explicit_oauth_consent

## Rules

- External sources remain disabled until explicit operator approval.
- Feed source is internal-only and may be used for offline persona refresh.
- System-passed internal context is controlled by system_internal with source allowlist (memory, loops, analytics).
- All ingestion events must be auditable and appended to persona memory.
