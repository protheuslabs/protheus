# Zhang Hao Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#zhang_hao cadence=daily consent=required
- LinkedIn: inbox=zhang_hao cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream zhang_hao`.
