# Liu Ying Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#liu_ying cadence=daily consent=required
- LinkedIn: inbox=liu_ying cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream liu_ying`.
