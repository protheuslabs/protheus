# Vikram Menon Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#security-architecture cadence=daily consent=required
- Slack: workspace=protheuslabs channel=#foundation-lock cadence=daily consent=required
- LinkedIn: inbox=vmenon cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream vikram_menon`.
