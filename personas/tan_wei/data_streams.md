# Tan Wei Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#tan_wei cadence=daily consent=required
- LinkedIn: inbox=tan_wei cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream tan_wei`.
