# Wang Jun Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#wang_jun cadence=daily consent=required
- LinkedIn: inbox=wang_jun cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream wang_jun`.
