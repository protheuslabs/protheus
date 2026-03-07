# Kavya Reddy Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#kavya_reddy cadence=daily consent=required
- LinkedIn: inbox=kavya_reddy cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream kavya_reddy`.
