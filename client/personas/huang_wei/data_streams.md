# Huang Wei Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#huang_wei cadence=daily consent=required
- LinkedIn: inbox=huang_wei cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream huang_wei`.
